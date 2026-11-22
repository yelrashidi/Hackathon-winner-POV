import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Actor, ActorRole } from "@/contracts/actor";
import { AuditInvoiceDetail } from "@/contracts/audit-view";
import { Forbidden } from "@/server/core/authorize";
import type { Db } from "@/server/db/client";
import { createSeededDb } from "@/server/db/__tests__/helpers";
import { invoiceFlags, invoiceLines, invoices, users } from "@/server/db/schema";
import { getApprovalPlans } from "@/server/features/approvals";
import { getInvoiceAuditDetail } from "@/server/features/audit";
import { loadIncomingFixtures } from "@/server/features/validation/dataset/batch";
import {
  acceptConfidentLines,
  ApprovalFlowError,
  codeInvoiceLine,
  CodingError,
  decideApproval,
  editInvoice,
  ingestInvoice,
  loadCodingContext,
  PostgresApprovalStore,
  revalidateInvoice,
  submitForApproval,
} from "..";

/**
 * Features 3 → 4 → 6 → 8 end to end on Postgres (PGlite), as the app's restricted role: one invoice
 * goes from extraction output to Approved the way people would drive it, and the auditor sees every
 * step. Nothing here names a dataset invoice: the invoices are picked by what they are.
 */

const TODAY = "2026-11-02";
let db: Db;
let client: PGlite;
let CLERK: Actor;
let AUDITOR: Actor;

const q = async <T>(sql: string) => (await client.query<T>(sql)).rows;
const actorFor = async (userId: string): Promise<Actor> => {
  const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
  return { userId, role: u!.role as ActorRole };
};

/** Clean incoming invoices (no expected validation flags) — the ones that can go straight through. */
const clean = loadIncomingFixtures().filter((f) => (f.fixture.expectedCodes ?? []).length === 0 && (f.fixture.input.totalCents ?? 0) > 0);

/** Confirm every line: bulk-accept the confident ones, then accept each remaining suggestion (or a fallback). */
async function confirmCoding(invoiceId: string) {
  await acceptConfidentLines(CLERK, invoiceId, { db });
  const open = await db.select().from(invoiceLines).where(and(eq(invoiceLines.invoiceId, invoiceId), eq(invoiceLines.codingSource, "suggested")));
  for (const l of open) {
    const [fallback] = await q<{ account_number: string }>("SELECT account_number FROM gl_accounts WHERE account_type = 'expense' ORDER BY account_number LIMIT 1");
    const [inv] = await db.select({ d: invoices.departmentId }).from(invoices).where(eq(invoices.id, invoiceId));
    await codeInvoiceLine(CLERK, invoiceId, l.lineNo, { glAccount: l.glAccountCode ?? fallback!.account_number, departmentId: l.departmentId ?? inv!.d ?? "D01", note: "Checked against the PDF." }, { db });
  }
}

/** Someone in the invoice's department who is not a manager / approver: a realistic requester. */
async function requesterFor(invoiceId: string): Promise<string> {
  const [inv] = await db.select({ d: invoices.departmentId }).from(invoices).where(eq(invoices.id, invoiceId));
  const [u] = await q<{ id: string }>(`SELECT id FROM users WHERE role = 'employee' AND status = 'active' AND department_id = '${inv!.d}' ORDER BY id LIMIT 1`);
  return u!.id;
}

/** Approve every step as whoever the plan says must act, acknowledging what the plan asks. */
async function approveAll(invoiceId: string) {
  const store = new PostgresApprovalStore(db);
  for (let i = 0; i < 6; i++) {
    const plans = await getApprovalPlans(invoiceId, { store });
    const plan = plans[plans.length - 1]!;
    const step = plan.steps.find((s) => s.decision === "pending");
    if (!step) return plan;
    const res = await decideApproval(await actorFor(step.assignedTo), invoiceId, { action: "approve", comment: "OK to pay.", acknowledgedFlags: plan.attention.map((a) => a.code) }, { db, now: new Date(`${TODAY}T15:00:00Z`) });
    expect(res.step.decision).toBe("approved");
  }
  throw new Error("approval did not finish");
}

beforeAll(async () => {
  ({ db, client } = await createSeededDb({ validateHistory: false }));
  const [clerk] = await q<{ id: string }>("SELECT id FROM users WHERE role = 'ap_clerk' AND status = 'active' ORDER BY id LIMIT 1");
  const [auditor] = await q<{ id: string }>("SELECT id FROM users WHERE role = 'auditor' ORDER BY id LIMIT 1");
  CLERK = { userId: clerk!.id, role: "ap_clerk" };
  AUDITOR = { userId: auditor!.id, role: "auditor" };
  await client.exec("SET ROLE ap_app");
}, 120_000);

describe("pipeline: extraction → coding + validation → review → approval → audit", () => {
  let id: string;

  it("ingest codes every line and validates, in one transaction", async () => {
    expect(clean.length).toBeGreaterThan(2);
    const r = await ingestInvoice(clean[0]!.fixture.input, { source: "email", today: TODAY, db });
    id = r.invoiceId;
    expect(r.result.flags).toEqual([]); // validation: clean
    expect(r.coding.lines.length).toBeGreaterThan(0);
    const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, id));
    expect(lines.every((l) => l.codingSource === "suggested" && l.codingReason)).toBe(true);
    const flags = await db.select().from(invoiceFlags).where(and(eq(invoiceFlags.invoiceId, id), eq(invoiceFlags.source, "coding")));
    expect(flags.map((f) => f.code)).toContain("CODING_NOT_CONFIRMED");
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, id));
    expect(inv!.departmentId).not.toBeNull(); // set from coding's invoiceDepartment
  });

  it("submit is refused until the requester is known", async () => {
    await expect(submitForApproval(CLERK, id, { db })).rejects.toMatchObject({ status: 409, code: "MISSING_FIELDS" });
  });

  it("a clerk confirms the coding; a high-confidence change needs a note; the auditor cannot code", async () => {
    const [line] = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, id)).limit(1);
    await expect(codeInvoiceLine(AUDITOR, id, line!.lineNo, { glAccount: line!.glAccountCode, departmentId: line!.departmentId }, { db })).rejects.toBeInstanceOf(Forbidden);
    const conf = (line!.codingReason as { account: { confidence: string } }).account.confidence;
    if (conf === "high") {
      const [other] = await q<{ account_number: string }>(`SELECT account_number FROM gl_accounts WHERE account_type = 'expense' AND account_number <> '${line!.glAccountCode}' LIMIT 1`);
      await expect(codeInvoiceLine(CLERK, id, line!.lineNo, { glAccount: other!.account_number, departmentId: line!.departmentId }, { db })).rejects.toMatchObject({ status: 400, code: "NOTE_REQUIRED" });
    }
    await confirmCoding(id);
    const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, id));
    expect(lines.every((l) => l.codingSource === "accepted" || l.codingSource === "changed")).toBe(true);
    const [notConfirmed] = await db.select().from(invoiceFlags).where(and(eq(invoiceFlags.invoiceId, id), eq(invoiceFlags.code, "CODING_NOT_CONFIRMED")));
    expect(notConfirmed!.status).toBe("resolved");
  });

  it("editing the invoice re-runs the analysis and keeps the confirmed coding", async () => {
    const before = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, id));
    const r = await editInvoice(CLERK, id, { requesterId: await requesterFor(id) }, { reason: "Requester confirmed by email", today: TODAY, db });
    expect(r.status).toBe("InReview");
    const after = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, id));
    expect(after.map((l) => [l.lineNo, l.glAccountCode, l.codingSource])).toEqual(before.map((l) => [l.lineNo, l.glAccountCode, l.codingSource]));
    await revalidateInvoice(id, { today: TODAY, db });
    const [stillResolved] = await db.select().from(invoiceFlags).where(and(eq(invoiceFlags.invoiceId, id), eq(invoiceFlags.code, "CODING_NOT_CONFIRMED")));
    expect(stillResolved!.status).toBe("resolved");
  });

  it("submit routes it and moves it to PendingApproval", async () => {
    const plan = await submitForApproval(CLERK, id, { db, now: new Date(`${TODAY}T14:00:00Z`) });
    expect(plan.outcome).toBe("route");
    expect(plan.steps.length).toBeGreaterThan(0);
    const [inv] = await db.select({ s: invoices.status }).from(invoices).where(eq(invoices.id, id));
    expect(inv!.s).toBe("PendingApproval");
  });

  it("the wrong person cannot approve, and the refusal is audited", async () => {
    const [inv] = await db.select({ r: invoices.requesterId }).from(invoices).where(eq(invoices.id, id));
    // An approver who is not the assignee of the current step.
    const plans = await getApprovalPlans(id, { store: new PostgresApprovalStore(db) });
    const assignee = plans.at(-1)!.steps.find((s) => s.decision === "pending")!.assignedTo;
    const [other] = await q<{ id: string; role: string }>(`SELECT id, role FROM users WHERE role IN ('approver','finance_manager') AND id <> '${assignee}' AND status = 'active' ORDER BY id LIMIT 1`);
    await expect(decideApproval({ userId: other!.id, role: other!.role as ActorRole }, id, { action: "approve" }, { db })).rejects.toBeInstanceOf(ApprovalFlowError);
    await expect(decideApproval({ userId: inv!.r!, role: "employee" }, id, { action: "approve" }, { db })).rejects.toBeInstanceOf(Forbidden);
    const denied = await q<{ n: number }>(`SELECT count(*)::int n FROM audit_events WHERE action = 'authz.denied' AND reason IS NOT NULL`);
    expect(denied[0]!.n).toBeGreaterThan(0);
  });

  it("the assigned approvers approve every step → Approved", async () => {
    await approveAll(id);
    const [inv] = await db.select({ s: invoices.status }).from(invoices).where(eq(invoices.id, id));
    expect(inv!.s).toBe("Approved");
  });

  it("coding learns: the confirmed lines are now history for the next invoice", async () => {
    const ctx = await loadCodingContext(db);
    const [inv] = await db.select({ v: invoices.vendorId }).from(invoices).where(eq(invoices.id, id));
    expect(ctx.history.vendorLines(inv!.v!).some((l) => l.invoiceId === id)).toBe(true);
  });

  it("the auditor sees every step: coding, validation, review, approvals, controls", async () => {
    const d = AuditInvoiceDetail.parse(await getInvoiceAuditDetail(AUDITOR, id, { db }));
    const actions = d.timeline.map((e) => e.action);
    for (const a of ["invoice.created", "invoice.validated", "invoice.coding_suggested", "invoice.line_coded", "invoice.edited", "approval.routed", "approval.decided"]) expect(actions).toContain(a);
    expect(d.timeline.filter((e) => e.action === "invoice.status_changed").map((e) => e.after?.status)).toEqual(expect.arrayContaining(["InReview", "PendingApproval", "Approved"]));
    expect(d.lines.every((l) => l.codingSource === "accepted" || l.codingSource === "changed")).toBe(true);
    expect(d.approvals.at(-1)!.steps.every((s) => s.decision === "approved" && s.actedBy)).toBe(true);
    expect(d.controls.find((c) => c.id === "APPROVER_NOT_REQUESTER")!.result).toBe("pass");
    expect(d.controls.find((c) => c.id === "APPROVAL_WITHIN_LIMIT")!.result).toBe("pass");
  });
});

describe("rejection and resubmission", () => {
  it("a rejected invoice goes back to review; resubmitting makes attempt 2", async () => {
    const r = await ingestInvoice(clean[1]!.fixture.input, { source: "upload", actor: CLERK, today: TODAY, db });
    await confirmCoding(r.invoiceId);
    await editInvoice(CLERK, r.invoiceId, { requesterId: await requesterFor(r.invoiceId) }, { today: TODAY, db });
    const plan = await submitForApproval(CLERK, r.invoiceId, { db });
    const step = plan.steps[0]!;
    await decideApproval(await actorFor(step.assignedTo), r.invoiceId, { action: "reject", comment: "Wrong cost centre — please recheck." }, { db });
    const [inv] = await db.select({ s: invoices.status }).from(invoices).where(eq(invoices.id, r.invoiceId));
    expect(inv!.s).toBe("InReview");
    const again = await submitForApproval(CLERK, r.invoiceId, { db });
    expect(again.planId).toBe(`${r.invoiceId}#2`);
  });

  it("an invoice with open blocking validation flags is refused with every reason", async () => {
    const blocked = loadIncomingFixtures().find((f) => (f.fixture.expectedCodes ?? []).includes("ARITH_TOTAL_MISMATCH"))!;
    const r = await ingestInvoice(blocked.fixture.input, { source: "email", today: TODAY, db });
    await confirmCoding(r.invoiceId);
    await editInvoice(CLERK, r.invoiceId, { requesterId: await requesterFor(r.invoiceId) }, { today: TODAY, db });
    const err = await submitForApproval(CLERK, r.invoiceId, { db }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApprovalFlowError);
    expect((err as ApprovalFlowError).code).toBe("BLOCKED");
    expect((err as ApprovalFlowError).reasons.join(" ")).toMatch(/ARITH_TOTAL_MISMATCH/);
  });
});

describe("history works with the approvals store", () => {
  it("every seeded plan loads through PostgresApprovalStore without being 'corrupt'", async () => {
    const store = new PostgresApprovalStore(db);
    const ids = await q<{ invoice_id: string }>("SELECT DISTINCT invoice_id FROM approval_plans WHERE invoice_id LIKE 'AP-%' ORDER BY invoice_id LIMIT 60");
    for (const { invoice_id } of ids) {
      const plans = await getApprovalPlans(invoice_id, { store });
      expect(plans[0]!.steps.length).toBeGreaterThan(0);
    }
  });

  it("CodingError is exported for route handlers", () => {
    expect(new CodingError("x", 409)).toBeInstanceOf(Error);
  });
});
