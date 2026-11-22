import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/contracts/actor";
import { Forbidden } from "@/server/core/authorize";
import type { Db } from "@/server/db/client";
import { createSeededDb } from "@/server/db/__tests__/helpers";
import { auditEvents, invoiceFlags, invoices } from "@/server/db/schema";
import { ingestInvoice, revalidateInvoice } from "@/server/pipeline";
import { loadIncomingFixtures } from "@/server/features/validation/dataset/batch";
import { confirmDuplicate, dismissDuplicate, DuplicateActionError, listDuplicateReviews } from "..";

/**
 * Duplicates on Postgres (PGlite), as the app's restricted role: the seed's history replay, the
 * analysis pass on a new invoice, and both human decisions with their audit trail.
 */

const TODAY = "2026-11-02";
const CLERK: Actor = { userId: "U004", role: "ap_clerk" };
const APPROVER: Actor = { userId: "U007", role: "approver" };
const fixture = (name: string) => loadIncomingFixtures().find((f) => f.file === name)!.fixture.input;
const dupFlags = (db: Db, invoiceId: string) => db.select().from(invoiceFlags).where(and(eq(invoiceFlags.invoiceId, invoiceId), eq(invoiceFlags.source, "duplicates")));

let db: Db;
let client: PGlite;

beforeAll(async () => {
  ({ db, client } = await createSeededDb({ validateHistory: false }));
  await client.exec("SET ROLE ap_app");
}, 180_000);

describe("seed history replay", () => {
  it("flags the second copy of a live pair still scheduled for payment", async () => {
    const reviews = await listDuplicateReviews({ db });
    const live = reviews.filter((r) => r.invoice.status === "PaymentScheduled" && r.code === "DUPLICATE_INVOICE");
    expect(live.length).toBeGreaterThan(0);
    for (const r of live) {
      expect(r.related).not.toBeNull();
      expect(r.related!.invoiceNumber).toBe(r.invoice.invoiceNumber);
      expect(r.canConfirm).toBe(false); // the state machine has no void after approval
    }
  });

  it("a duplicate past review cannot be confirmed; the reason says why", async () => {
    const [r] = (await listDuplicateReviews({ db })).filter((x) => !x.canConfirm);
    await expect(confirmDuplicate(CLERK, r!.flagId, "same bill", { db })).rejects.toMatchObject({ status: 409 });
  });
});

describe("analysis pass on a new invoice", () => {
  it("ingest raises a blocking duplicate flag with the earlier invoice and audits the check", async () => {
    const out = await ingestInvoice(fixture("harlowsternllp-001468.json"), { source: "upload", today: TODAY, db });
    expect(out.duplicates.result.flags.map((f) => f.code)).toEqual(["DUPLICATE_INVOICE"]);
    const [stored] = await dupFlags(db, out.invoiceId);
    expect(stored).toMatchObject({ code: "DUPLICATE_INVOICE", severity: "block", status: "open" });
    expect(stored!.relatedInvoiceId).toBeTruthy();
    const checked = await db.select().from(auditEvents).where(and(eq(auditEvents.invoiceId, out.invoiceId), eq(auditEvents.action, "invoice.duplicates_checked")));
    expect(checked.length).toBe(1);
  });

  it("'not a duplicate' needs a note, overrides the flag, and survives a re-run", async () => {
    const id = fixture("harlowsternllp-001468.json").invoiceId;
    const [flag] = await dupFlags(db, id);
    await expect(dismissDuplicate(CLERK, flag!.id, "  ", { db })).rejects.toBeInstanceOf(DuplicateActionError);
    await dismissDuplicate(CLERK, flag!.id, "Second engagement letter, separate matter", { db });
    await revalidateInvoice(id, { db, today: TODAY });
    const [after] = await dupFlags(db, id);
    expect(after).toMatchObject({ status: "overridden", resolvedBy: "U004" });
    expect(after!.resolutionNote).toContain("Not a duplicate");
  });

  it("confirming voids the invoice through fire() and resolves its duplicate flags", async () => {
    const out = await ingestInvoice(fixture("voyageurcorporat-inv-017.json"), { source: "upload", today: TODAY, db });
    const [flag] = await dupFlags(db, out.invoiceId);
    const res = await confirmDuplicate(CLERK, flag!.id, "Re-issue of the paid original", { db });
    expect(res.status).toBe("Voided");
    const [inv] = await db.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, out.invoiceId));
    expect(inv!.status).toBe("Voided");
    expect((await dupFlags(db, out.invoiceId)).every((f) => f.status === "resolved")).toBe(true);
    const moved = await db.select().from(auditEvents).where(and(eq(auditEvents.invoiceId, out.invoiceId), eq(auditEvents.action, "invoice.status_changed")));
    expect(moved.some((e) => (e.metadata as { event?: string }).event === "confirmDuplicate" && e.actorId === "U004")).toBe(true);
    // gone from the queue
    expect((await listDuplicateReviews({ db })).some((r) => r.invoice.invoiceId === out.invoiceId)).toBe(false);
  });

  it("a same-number pair over the approval limit shows the duplicate with its split fact; confirming clears both", async () => {
    const out = await ingestInvoice(fixture("invoice-000961.json"), { source: "upload", today: TODAY, db });
    expect(out.duplicates.result.flags.map((f) => f.code)).toEqual(["DUPLICATE_INVOICE", "SPLIT_IF_NOT_DUPLICATE"]);
    const card = (await listDuplicateReviews({ db })).filter((r) => r.invoice.invoiceId === out.invoiceId);
    expect(card.map((r) => r.code)).toEqual(["DUPLICATE_INVOICE"]); // the split fact is not a card of its own
    expect(card[0]!.splitFacts).toEqual([expect.objectContaining({ code: "SPLIT_IF_NOT_DUPLICATE", source: "duplicates", thresholdCadCents: 1_000_000 })]);
    await confirmDuplicate(CLERK, card[0]!.flagId, "Same invoice sent twice", { db });
    expect((await dupFlags(db, out.invoiceId)).map((f) => f.status)).toEqual(["resolved", "resolved"]);
  });

  it("an approver may not decide duplicates (server-side), and the refusal is logged", async () => {
    const out = await ingestInvoice(fixture("cloudbarnsoftwar-inv01561.json"), { source: "upload", today: TODAY, db });
    const [flag] = await dupFlags(db, out.invoiceId);
    await expect(confirmDuplicate(APPROVER, flag!.id, "x", { db })).rejects.toBeInstanceOf(Forbidden);
    await expect(dismissDuplicate(APPROVER, flag!.id, "x", { db })).rejects.toBeInstanceOf(Forbidden);
    const denied = await db.select().from(auditEvents).where(and(eq(auditEvents.action, "authz.denied"), eq(auditEvents.actorId, "U007")));
    expect(denied.length).toBeGreaterThanOrEqual(2);
  });
});
