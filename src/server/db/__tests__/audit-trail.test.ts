import type { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_ACTOR, type Actor } from "@/contracts/actor";
import { AuditInvoiceDetail, AuditInvoiceList } from "@/contracts/audit-view";
import { withAction } from "@/server/core/audit";
import { Forbidden } from "@/server/core/authorize";
import { fire, TransitionError } from "@/server/core/fire";
import { exportAuditCsv, getInvoiceAuditDetail, getPaymentAuditDetail, listAuditInvoices } from "@/server/features/audit";
import { loadIncomingFixtures } from "@/server/features/validation/dataset/batch";
import { readCsv } from "@/server/features/validation/dataset/csv";
import { ingestInvoice, revalidateInvoice } from "@/server/pipeline";
import { overrideFlag, resolveFlag } from "@/server/features/validation/db/override";
import type { Db } from "../client";
import { auditEvents, invoiceFlags, invoices } from "../schema";
import { createSeededDb } from "./helpers";

/**
 * Feature 8 end to end on a real Postgres (PGlite, in-process): migrations, seed, the append-only
 * guarantees, new invoices flowing in, overrides, the state machine, and the auditor dashboard.
 * After seeding, the connection switches to the app's restricted role `ap_app`, so everything
 * below runs with the same permissions the app has in production.
 */

const AUDITOR: Actor = { userId: "U040", role: "auditor" };
const CLERK: Actor = { userId: "U004", role: "ap_clerk" };
const TODAY = "2026-11-02";

let db: Db;
let client: PGlite;
let counts: Record<string, number>;

const rows = async <T = Record<string, unknown>>(q: string) => (await client.query<T>(q)).rows;
const csvRows = (f: string) => readCsv(f).length;

beforeAll(async () => {
  ({ db, client, counts } = await createSeededDb({ validateHistory: true }));
  // pick a real auditor + clerk from the seeded users rather than assuming ids
  const [auditor] = await rows<{ id: string }>("SELECT id FROM users WHERE role = 'auditor' ORDER BY id LIMIT 1");
  const [clerk] = await rows<{ id: string }>("SELECT id FROM users WHERE role = 'ap_clerk' ORDER BY id LIMIT 1");
  AUDITOR.userId = auditor!.id;
  CLERK.userId = clerk!.id;
  await client.exec("SET ROLE ap_app");
}, 120_000);

describe("seed", () => {
  it("loads every CSV row and reconstructs history's audit trail", async () => {
    expect(counts.invoices).toBe(csvRows("invoices.csv"));
    expect(counts.invoiceLines).toBe(csvRows("invoice_lines.csv"));
    expect(counts.payments).toBe(csvRows("payments.csv"));
    expect(counts.approvalSteps).toBe(csvRows("approvals.csv"));
    expect(counts.validated).toBe(csvRows("invoices.csv"));
    const [imported] = await rows<{ n: number }>("SELECT count(*)::int n FROM audit_events WHERE action = 'invoice.imported'");
    expect(imported!.n).toBe(csvRows("invoices.csv"));
  });
});

describe("audit_events is append-only", () => {
  it("the app role cannot update, delete or truncate history", async () => {
    await expect(client.query("UPDATE audit_events SET reason = 'tampered'")).rejects.toThrow(/permission denied/);
    await expect(client.query("DELETE FROM audit_events")).rejects.toThrow(/permission denied/);
    await expect(client.query("TRUNCATE audit_events")).rejects.toThrow(/permission denied/);
  });

  it("the app role cannot backdate an event", async () => {
    await expect(
      client.query("INSERT INTO audit_events (occurred_at, request_id, actor_id, actor_role, action, entity_type, entity_id) VALUES ('2020-01-01', gen_random_uuid(), 'SYSTEM', 'system', 'invoice.edited', 'invoice', 'x')"),
    ).rejects.toThrow(/permission denied/);
  });

  it("even the owner is stopped by the trigger", async () => {
    await client.exec("RESET ROLE");
    try {
      await expect(client.query("UPDATE audit_events SET reason = 'tampered'")).rejects.toThrow(/append-only/);
      await expect(client.query("DELETE FROM audit_events")).rejects.toThrow(/append-only/);
    } finally {
      await client.exec("SET ROLE ap_app");
    }
  });

  it("an audit row and its change commit together or not at all", async () => {
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(auditEvents);
    await expect(
      withAction(
        SYSTEM_ACTOR,
        async ({ tx, audit }) => {
          await tx.update(invoices).set({ shipToProvince: "ZZ" }).where(eq(invoices.id, "AP-00001"));
          await audit({ action: "invoice.edited", entityType: "invoice", entityId: "AP-00001", invoiceId: "AP-00001", after: { shipToProvince: "ZZ" } });
          throw new Error("boom");
        },
        { db },
      ),
    ).rejects.toThrow("boom");
    const after = await db.select({ n: sql<number>`count(*)::int` }).from(auditEvents);
    expect(after[0]!.n).toBe(before[0]!.n);
    const [inv] = await db.select({ p: invoices.shipToProvince }).from(invoices).where(eq(invoices.id, "AP-00001"));
    expect(inv!.p).not.toBe("ZZ");
  });
});

describe("new invoices flow into the database", () => {
  const fixtures = loadIncomingFixtures();

  it("ingests every incoming invoice; after all are in, re-validation matches the batch expectations", async () => {
    for (const { fixture } of fixtures) {
      const r = await ingestInvoice(fixture.input, { source: "email", today: TODAY, db });
      expect(r.status).toBe("InReview");
    }
    const [n] = await rows<{ n: number }>("SELECT count(*)::int n FROM invoices WHERE source = 'email'");
    expect(n!.n).toBe(fixtures.length);

    // Each invoice now sees all the others (like validateBatch): same flags as the CSV-based run.
    const mismatches: string[] = [];
    for (const { file, fixture } of fixtures) {
      const { result } = await revalidateInvoice(fixture.input.invoiceId, { today: TODAY, db });
      const got = [...new Set(result.flags.map((f) => f.code))].sort();
      const want = [...(fixture.expectedCodes ?? [])].sort();
      if (JSON.stringify(got) !== JSON.stringify(want)) mismatches.push(`${file}: expected ${want.join(",") || "-"} got ${got.join(",") || "-"}`);
    }
    expect(mismatches).toEqual([]);
  }, 120_000);

  it("records who/what/when for an ingested invoice and enriches the row", async () => {
    const id = fixtures[0]!.fixture.input.invoiceId;
    const actions = await rows<{ action: string }>(`SELECT action FROM audit_events WHERE invoice_id = '${id}' ORDER BY id`);
    expect(actions.map((a) => a.action).slice(0, 3)).toEqual(["invoice.created", "invoice.status_changed", "invoice.edited"]);
    expect(actions.map((a) => a.action)).toContain("invoice.validated");
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, id));
    expect(inv!.vendorId).not.toBeNull();
    expect(inv!.totalCadCents).not.toBeNull();
    expect(inv!.extractionRaw).toMatchObject({ invoiceId: id });
  });

  it("refuses the same invoice id twice", async () => {
    await expect(ingestInvoice(fixtures[0]!.fixture.input, { source: "email", today: TODAY, db })).rejects.toMatchObject({ status: 409 });
  });

  it("re-validation keeps a human override and auto-resolves flags that went away", async () => {
    // An open VALIDATION flag on a NEW invoice (the "screen 2 for a NEW invoice" test reads this override).
    const [flag] = await rows<{ id: number; invoiceId: string }>(
      `SELECT f.id, f.invoice_id AS "invoiceId" FROM invoice_flags f JOIN invoices i ON i.id = f.invoice_id WHERE f.status = 'open' AND f.source = 'validation' AND i.source <> 'historical' ORDER BY f.id LIMIT 1`,
    );
    await overrideFlag(CLERK, flag!.id, "Confirmed with the vendor by phone; acceptable for this period.", { db });
    await revalidateInvoice(flag!.invoiceId, { today: TODAY, db });
    const [after] = await db.select().from(invoiceFlags).where(eq(invoiceFlags.id, flag!.id));
    expect(after!.status).toBe("overridden");
    expect(after!.resolvedBy).toBe(CLERK.userId);

  });

  it("fixing the cause and re-validating auto-resolves the flag as `system`", async () => {
    const [mismatch] = await db
      .select()
      .from(invoiceFlags)
      .where(sql`${invoiceFlags.code} = 'ARITH_TOTAL_MISMATCH' AND ${invoiceFlags.status} = 'open' AND ${invoiceFlags.source} = 'validation' AND ${invoiceFlags.invoiceId} NOT LIKE 'AP-%'`)
      .limit(1);
    expect(mismatch).toBeTruthy();
    const expected = (mismatch!.evidence as { expectedCents?: number }).expectedCents;
    expect(typeof expected).toBe("number");
    await db.update(invoices).set({ totalCents: expected! }).where(eq(invoices.id, mismatch!.invoiceId));
    await revalidateInvoice(mismatch!.invoiceId, { today: TODAY, db });
    const [after] = await db.select().from(invoiceFlags).where(eq(invoiceFlags.id, mismatch!.id));
    expect(after).toMatchObject({ status: "resolved", resolvedBy: "SYSTEM" });
    const [ev] = await rows<{ action: string }>(`SELECT action FROM audit_events WHERE entity_type = 'invoice_flag' AND entity_id = '${mismatch!.id}' ORDER BY id DESC LIMIT 1`);
    expect(ev!.action).toBe("flag.auto_resolved");
  });
});

describe("closing flags", () => {
  it("override needs a note; the DB enforces it too", async () => {
    const [flag] = await db.select().from(invoiceFlags).where(eq(invoiceFlags.status, "open")).limit(1);
    await expect(overrideFlag(CLERK, flag!.id, "   ", { db })).rejects.toMatchObject({ status: 400 });
    await expect(client.query(`UPDATE invoice_flags SET status = 'overridden', resolved_by = '${CLERK.userId}' WHERE id = ${flag!.id}`)).rejects.toThrow(/override_note/);
  });

  it("only the right roles may close a flag, and a refusal is audited", async () => {
    const [flag] = await db.select().from(invoiceFlags).where(eq(invoiceFlags.status, "open")).limit(1);
    await expect(overrideFlag(AUDITOR, flag!.id, "auditors write nothing", { db })).rejects.toBeInstanceOf(Forbidden);
    const [denied] = await rows<{ actor_id: string; reason: string }>("SELECT actor_id, reason FROM audit_events WHERE action = 'authz.denied' ORDER BY id DESC LIMIT 1");
    expect(denied!.actor_id).toBe(AUDITOR.userId);
    expect(denied!.reason).toMatch(/cannot override flags/);
  });

  it("resolve records who and why", async () => {
    const [flag] = await db.select().from(invoiceFlags).where(eq(invoiceFlags.status, "open")).limit(1);
    const updated = await resolveFlag(CLERK, flag!.id, "Vendor sent a corrected invoice.", { db });
    expect(updated).toMatchObject({ status: "resolved", resolvedBy: CLERK.userId, resolutionNote: "Vendor sent a corrected invoice." });
    const [ev] = await rows<{ action: string; reason: string }>(`SELECT action, reason FROM audit_events WHERE entity_type = 'invoice_flag' AND entity_id = '${flag!.id}' ORDER BY id DESC LIMIT 1`);
    expect(ev).toEqual({ action: "flag.resolved", reason: "Vendor sent a corrected invoice." });
  });
});

describe("fire(): the state machine writes its own audit trail", () => {
  it("refuses submit while a blocking flag is open, allows it once it is overridden", async () => {
    const [blocked] = await rows<{ invoice_id: string; id: number }>(
      "SELECT f.invoice_id, f.id FROM invoice_flags f JOIN invoices i ON i.id = f.invoice_id WHERE f.status = 'open' AND f.severity = 'block' AND i.status = 'InReview' LIMIT 1",
    );
    expect(blocked).toBeTruthy();
    await expect(withAction(CLERK, (ctx) => fire(ctx, blocked!.invoice_id, "submit"), { db })).rejects.toBeInstanceOf(TransitionError);

    const others = await rows<{ id: number }>(`SELECT id FROM invoice_flags WHERE invoice_id = '${blocked!.invoice_id}' AND status = 'open' AND severity = 'block'`);
    for (const f of others) await overrideFlag(CLERK, f.id, "Reviewed and accepted for the test.", { db });
    const res = await withAction(CLERK, (ctx) => fire(ctx, blocked!.invoice_id, "submit"), { db });
    expect(res).toMatchObject({ from: "InReview", to: "PendingApproval" });
    const [ev] = await rows<{ before: unknown; after: unknown; actor_id: string }>(
      `SELECT before, after, actor_id FROM audit_events WHERE invoice_id = '${blocked!.invoice_id}' AND action = 'invoice.status_changed' ORDER BY id DESC LIMIT 1`,
    );
    expect(ev).toMatchObject({ before: { status: "InReview" }, after: { status: "PendingApproval" }, actor_id: CLERK.userId });
  });

  it("rejects an illegal transition", async () => {
    await expect(withAction(CLERK, (ctx) => fire(ctx, "AP-00001", "submit"), { db })).rejects.toThrow(/not allowed while the invoice is Paid/);
  });
});

describe("auditor dashboard", () => {
  it.each<Actor>([
    { userId: "U004", role: "ap_clerk" },
    { userId: "U003", role: "controller_admin" },
    { userId: "U002", role: "finance_manager" },
    { userId: "U010", role: "approver" },
    { userId: "U020", role: "employee" },
  ])("$role cannot open the audit log", async (actor) => {
    await expect(listAuditInvoices(actor, {}, { db })).rejects.toBeInstanceOf(Forbidden);
    await expect(getInvoiceAuditDetail(actor, "AP-00001", { db })).rejects.toBeInstanceOf(Forbidden);
    await expect(exportAuditCsv(actor, {}, { db })).rejects.toBeInstanceOf(Forbidden);
  });

  it("screen 1: lists every invoice with links-worth of summary, filterable", async () => {
    const all = AuditInvoiceList.parse(await listAuditInvoices(AUDITOR, { pageSize: 200 }, { db }));
    expect(all.total).toBe(csvRows("invoices.csv") + loadIncomingFixtures().length);
    expect(all.rows).toHaveLength(200);
    const overridden = await listAuditInvoices(AUDITOR, { hasOverrides: true }, { db });
    expect(overridden.total).toBeGreaterThan(0);
    expect(overridden.rows.every((r) => r.flags.overridden > 0)).toBe(true);
    const paid = await listAuditInvoices(AUDITOR, { search: "AP-00001", status: "Paid" }, { db });
    expect(paid.rows.map((r) => r.invoiceId)).toContain("AP-00001");
    expect(paid.rows[0]!.finalApprover?.person.name).toBeTruthy();
    expect(paid.rows[0]!.payment?.releasedBy?.name).toBeTruthy();
  });

  it("screen 2: one invoice — validation, flags, approval chain, payments, controls, timeline", async () => {
    const d = AuditInvoiceDetail.parse(await getInvoiceAuditDetail(AUDITOR, "AP-00001", { db }));
    expect(d.lines.length).toBeGreaterThan(0);
    expect(d.lines[0]!.glAccount?.code).toBeTruthy();
    expect(d.validationRuns.length).toBeGreaterThan(0);
    expect(d.approvals[0]!.steps[0]!.actedBy?.name).toBeTruthy();
    expect(d.payments[0]!.releasedBy).not.toBeNull();
    expect(d.controls.map((c) => c.id)).toContain("RELEASER_DID_NOT_APPROVE");
    expect(d.timeline.map((e) => e.action)).toEqual(expect.arrayContaining(["invoice.imported", "approval.decided", "payment.released", "invoice.validated"]));
    expect(d.timeline.every((e, i, a) => i === 0 || a[i - 1]!.occurredAt <= e.occurredAt)).toBe(true);

    const fromPayment = await getPaymentAuditDetail(AUDITOR, d.payments[0]!.paymentId, { db });
    expect(fromPayment.invoice.invoiceId).toBe("AP-00001");
  });

  it("screen 2 for a NEW invoice shows its override with who and why", async () => {
    const [f] = await rows<{ invoice_id: string }>("SELECT invoice_id FROM invoice_flags WHERE status = 'overridden' LIMIT 1");
    const d = await getInvoiceAuditDetail(AUDITOR, f!.invoice_id, { db });
    const o = d.flags.find((x) => x.status === "overridden")!;
    expect(o.resolvedBy?.userId).toBe(CLERK.userId);
    expect(o.resolutionNote).toBeTruthy();
    expect(d.timeline.some((e) => e.action === "flag.overridden" && e.reason === o.resolutionNote)).toBe(true);
    expect(d.extraction.raw).not.toBeNull();
  });

  it("exports the log as CSV", async () => {
    const out = await exportAuditCsv(AUDITOR, { invoiceId: "AP-00001" }, { db });
    const lines = out.csv.trim().split("\r\n");
    expect(lines[0]).toMatch(/^event_id,occurred_at,action,actor_id/);
    expect(lines.length - 1).toBe(out.rows);
    expect(out.rows).toBeGreaterThan(3);
  });
});
