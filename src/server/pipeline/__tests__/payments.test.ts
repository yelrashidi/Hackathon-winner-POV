import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Actor, ActorRole } from "@/contracts/actor";
import type { Db } from "@/server/db/client";
import { createSeededDb } from "@/server/db/__tests__/helpers";
import { invoices, payments, users, vendorBankAccounts } from "@/server/db/schema";
import { setEftRail, SimulatedEft } from "@/server/features/payments";
import { paymentsDb } from "..";

/**
 * Katie's payments service on Postgres (pipeline/payments.ts): every action loads its state from
 * the tables, runs the unchanged rules, and writes payments / flags / bank accounts / invoice status
 * / audit rows back in one transaction. Invoices are picked by what they are, never by id.
 */

let db: Db;
let client: PGlite;
const q = async <T>(sql: string) => (await client.query<T>(sql)).rows;
const actor = async (role: ActorRole): Promise<Actor> => {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.role, role)).orderBy(users.id).limit(1);
  return { userId: u!.id, role };
};
let CLERK: Actor;
let FM: Actor;
let ADMIN: Actor;

beforeAll(async () => {
  ({ db, client } = await createSeededDb());
  setEftRail(new SimulatedEft());
  [CLERK, FM, ADMIN] = await Promise.all([actor("ap_clerk"), actor("finance_manager"), actor("controller_admin")]);
}, 120_000);

describe("payments on the database", () => {
  it("reads the open work: approved invoices await payment, scheduled ones carry their payment", async () => {
    const view = await paymentsDb.list(FM.userId, { db });
    const [counted] = await q<{ n: number }>("SELECT count(*)::int AS n FROM invoices WHERE status = 'Approved'");
    const approved = counted!.n;
    expect(view.awaitingPayment.length).toBeGreaterThan(0);
    expect(view.awaitingPayment.length).toBeLessThanOrEqual(approved);
    expect(view.payments.every((p) => p.current.status === "scheduled")).toBe(true);
    // approvals' answer came from approval_steps, not from a seed copy
    expect(view.payments.some((p) => p.invoice.approvedBy.length > 0)).toBe(true);
  });

  it("schedule → release → settle writes each step to the tables, through fire(), with audit rows", async () => {
    const view = await paymentsDb.list(CLERK.userId, { db });
    const invoice = view.awaitingPayment[0]!;
    const scheduled = await paymentsDb.schedule(CLERK, { invoiceId: invoice.invoiceId }, { db });
    expect(scheduled.ok, JSON.stringify(scheduled)).toBe(true);
    if (!scheduled.ok) return;
    const paymentId = scheduled.value.paymentId;

    const [row] = await db.select().from(payments).where(eq(payments.id, paymentId));
    expect(row).toMatchObject({ status: "scheduled", preparedBy: CLERK.userId, invoiceId: invoice.invoiceId });
    expect(row!.bankAccountId).not.toBeNull();
    expect((await db.select({ s: invoices.status }).from(invoices).where(eq(invoices.id, invoice.invoiceId)))[0]!.s).toBe("PaymentScheduled");

    // Whoever the rules allow releases it (never the clerk who scheduled it).
    const [releasers] = await paymentsDb.eligibleReleasers([invoice.invoiceId], { db });
    expect(releasers!.map((p) => p.userId)).not.toContain(CLERK.userId);
    const releaserId = releasers![0]!.userId;
    const [r] = await db.select({ role: users.role }).from(users).where(eq(users.id, releaserId));
    const released = await paymentsDb.release({ userId: releaserId, role: r!.role as ActorRole }, { paymentId }, { db });
    expect(released.ok, JSON.stringify(released)).toBe(true);

    const settled = await paymentsDb.settle(CLERK, { paymentId, outcome: "SETTLED" }, { db });
    expect(settled.ok).toBe(true);
    expect((await db.select({ s: invoices.status }).from(invoices).where(eq(invoices.id, invoice.invoiceId)))[0]!.s).toBe("Paid");

    const events = await q<{ action: string; actor_id: string }>(`SELECT action, actor_id FROM audit_events WHERE invoice_id = '${invoice.invoiceId}' AND NOT coalesce((metadata->>'imported')::boolean, false) ORDER BY id`);
    // The service's own order: the invoice moves (fire), then the payment event that caused it.
    expect(events.map((e) => e.action)).toEqual(["invoice.status_changed", "payment.scheduled", "payment.released", "invoice.status_changed", "payment.settled"]);
    expect(events.find((e) => e.action === "payment.released")!.actor_id).toBe(releaserId);

    // A paid-in-the-app invoice stays visible on the dashboard, settled.
    const after = await paymentsDb.detail(FM.userId, invoice.invoiceId, { db });
    expect(after?.current.status).toBe("settled");
    const trail = await paymentsDb.audit(FM.userId, invoice.invoiceId, { db });
    expect(trail.map((e) => e.action)).toContain("invoice.paymentSettled");
  });

  it("the Admin does not schedule, and releases any amount, but never what they approved (brief P09–P11)", async () => {
    const view = await paymentsDb.list(ADMIN.userId, { db });
    const awaiting = view.awaitingPayment[0];
    if (awaiting) {
      const refused = await paymentsDb.schedule(ADMIN, { invoiceId: awaiting.invoiceId }, { db });
      expect(refused).toMatchObject({ ok: false, status: 403, reasons: [{ code: "ADMIN_NO_PAYMENTS" }] });
    }
    const scheduled = view.payments.filter((p) => p.current.status === "scheduled");
    const releasers = await paymentsDb.eligibleReleasers(scheduled.map((p) => p.invoice.invoiceId), { db });
    // One the Finance Manager could release (≤ $100k) → the Admin may release it too.
    const fmCan = scheduled.findIndex((_, i) => releasers[i]!.some((p) => p.userId === FM.userId) && releasers[i]!.some((p) => p.userId === ADMIN.userId));
    expect(fmCan).toBeGreaterThanOrEqual(0);
    const released = await paymentsDb.release(ADMIN, { paymentId: scheduled[fmCan]!.current.paymentId }, { db });
    expect(released.ok, JSON.stringify(released)).toBe(true);

    // One the Finance Manager approved (separation of duties) → the Admin is the one who releases it.
    const fmBlocked = scheduled.findIndex((p, i) => p.invoice.approvedBy.some((a) => a.userId === FM.userId) && releasers[i]!.some((x) => x.userId === ADMIN.userId));
    if (fmBlocked >= 0) {
      const ok = await paymentsDb.release(ADMIN, { paymentId: scheduled[fmBlocked]!.current.paymentId }, { db });
      expect(ok.ok, JSON.stringify(ok)).toBe(true);
    }
  });

  it("a failed transfer raises a flag and closes a dead account; a bank change needs two people", async () => {
    const view = await paymentsDb.list(FM.userId, { db });
    const scheduled = view.payments.filter((p) => p.current.status === "scheduled");
    const releasers = await paymentsDb.eligibleReleasers(scheduled.map((p) => p.invoice.invoiceId), { db });
    const i = scheduled.findIndex((_, k) => releasers[k]!.some((p) => p.userId === FM.userId));
    const row = scheduled[i]!;
    expect((await paymentsDb.release(FM, { paymentId: row.current.paymentId }, { db })).ok).toBe(true);

    const failed = await paymentsDb.settle(CLERK, { paymentId: row.current.paymentId, outcome: "ACCOUNT_CLOSED" }, { db });
    expect(failed.ok).toBe(true);
    const [flag] = await q<{ urgency: string; scope: string }>(`SELECT urgency, scope FROM payment_flags WHERE payment_id = '${row.current.paymentId}'`);
    expect(flag).toEqual({ urgency: "high", scope: "supplier" });
    const vendorId = row.invoice.vendorId;
    const banks = await db.select().from(vendorBankAccounts).where(eq(vendorBankAccounts.vendorId, vendorId));
    expect(banks.find((b) => b.version === row.current.bankAccount.version)!.status).toBe("closed");
    expect((await db.select({ s: invoices.status }).from(invoices).where(eq(invoices.id, row.invoice.invoiceId)))[0]!.s).toBe("Approved");

    const requested = await paymentsDb.requestBankChange(CLERK, { vendorId, institution: "001", transit: "12345", account: "9876543210" }, { db });
    expect(requested.ok, JSON.stringify(requested)).toBe(true);
    const selfVerify = await paymentsDb.verifyBankChange({ ...CLERK }, { vendorId }, { db });
    expect(selfVerify.ok).toBe(false);
    const verified = await paymentsDb.verifyBankChange(FM, { vendorId }, { db });
    expect(verified.ok, JSON.stringify(verified)).toBe(true);
    const after = await db.select().from(vendorBankAccounts).where(eq(vendorBankAccounts.vendorId, vendorId));
    expect(after.filter((b) => b.status === "verified")).toHaveLength(1);
    expect(after.find((b) => b.status === "verified")).toMatchObject({ last4: "3210", requestedBy: CLERK.userId, verifiedBy: FM.userId });
    // The high flag cleared itself once new details were verified.
    const [cleared] = await q<{ cleared_automatically: boolean }>(`SELECT cleared_automatically FROM payment_flags WHERE payment_id = '${row.current.paymentId}'`);
    expect(cleared!.cleared_automatically).toBe(true);
  });
});
