import { eq } from "drizzle-orm";
import type { Actor } from "@/contracts/actor";
import type { FailureCode, PaymentFlag, PaymentRecord, PaymentRow, PaymentsView, Person } from "@/contracts/payment";
import { getDb, setDb, type Db } from "@/server/db/client";
import { users } from "@/server/db/schema";
import {
  canClearFlag,
  cancelPayment,
  clearFlag,
  eligibleReleasers,
  getPaymentAudit,
  getPaymentDetail,
  getSupplierBank,
  listPayments,
  rejectBankChange,
  releasePayment,
  requestBankChange,
  schedulePayment,
  simulateSettlement,
  verifyBankChange,
  type ActionResult,
  type AuditEvent,
} from "@/server/features/payments";

/**
 * The dashboard's door to payments (feature 7, Katie's service — on Postgres since PR #15).
 * Same calls as the service, plus the one rule the brief gives the Admin (adminReleaseGuard):
 * P09–P11 — the Finance Manager releases up to $100,000 CAD, the Controller over $100,000, and nobody
 * releases what they approved. On this dashboard the Admin (controller_admin) releases ONLY a payment
 * the Finance Manager can't, and does not schedule or cancel (AP Clerks prepare; P09 note).
 */

type Opts = { db?: Db };
type Refusal = Extract<ActionResult<never>, { ok: false }>;

/** Tests pass their database; the app uses getDb(). */
function withDb(opts: Opts) {
  if (opts.db) setDb(opts.db);
}

async function rolesOf(ids: string[]): Promise<Map<string, string>> {
  const rows = await getDb().select({ id: users.id, role: users.role }).from(users);
  return new Map(rows.filter((r) => ids.includes(r.id)).map((r) => [r.id, r.role]));
}

async function roleOf(userId: string): Promise<string | undefined> {
  const [u] = await getDb().select({ role: users.role }).from(users).where(eq(users.id, userId));
  return u?.role;
}

/** Who may release, with the Admin listed only when no Finance Manager can. */
async function releasersFor(invoiceId: string): Promise<Person[]> {
  const people = await eligibleReleasers(invoiceId);
  const roles = await rolesOf(people.map((p) => p.userId));
  return people.some((p) => roles.get(p.userId) === "finance_manager") ? people.filter((p) => roles.get(p.userId) !== "controller_admin") : people;
}

async function adminReleaseGuard(actorId: string, paymentId: string): Promise<Refusal | null> {
  if ((await roleOf(actorId)) !== "controller_admin") return null;
  const view = await listPayments(actorId);
  const row = view.payments.find((p) => p.attempts.some((a) => a.paymentId === paymentId));
  if (!row) return null; // the service answers "not found" itself
  const people = await eligibleReleasers(row.invoice.invoiceId);
  const roles = await rolesOf(people.map((p) => p.userId));
  const fm = people.filter((p) => roles.get(p.userId) === "finance_manager");
  if (fm.length === 0) return null;
  return {
    ok: false,
    status: 403,
    reasons: [
      {
        code: "FINANCE_MANAGER_RELEASES",
        message: `${fm.map((p) => p.name).join(" or ")} (Finance Manager) can release this payment. The Admin releases only what the Finance Manager can't: payments over $100,000 CAD, or ones the Finance Manager approved, scheduled or requested.`,
      },
    ],
  };
}

async function adminCannot(actorId: string, what: string): Promise<Refusal | null> {
  if ((await roleOf(actorId)) !== "controller_admin") return null;
  return { ok: false, status: 403, reasons: [{ code: "ADMIN_NO_PAYMENTS", message: `The Admin doesn't ${what}: AP Clerks prepare payments and the Finance Manager releases them. The Admin only releases what the Finance Manager can't.` }] };
}

export const paymentsDb = {
  list: (viewerId: string | null, opts: Opts = {}): Promise<PaymentsView> => (withDb(opts), listPayments(viewerId)),
  detail: (viewerId: string | null, invoiceId: string, opts: Opts = {}): Promise<PaymentRow | null> => (withDb(opts), getPaymentDetail(viewerId, invoiceId)),
  audit: (viewerId: string | null, invoiceId: string, opts: Opts = {}): Promise<AuditEvent[]> => (withDb(opts), getPaymentAudit(viewerId, invoiceId)),
  eligibleReleasers: (invoiceIds: string[], opts: Opts = {}): Promise<Person[][]> => (withDb(opts), Promise.all(invoiceIds.map(releasersFor))),
  supplierBank: (viewerId: string | null, vendorId: string, opts: Opts = {}) => (withDb(opts), getSupplierBank(viewerId, vendorId)),
  canClearFlags: async (viewerId: string | null, flagIds: string[], opts: Opts = {}): Promise<Record<string, boolean>> => {
    withDb(opts);
    return Object.fromEntries(await Promise.all(flagIds.map(async (id) => [id, await canClearFlag(viewerId, id)] as const)));
  },

  schedule: async (actor: Actor, input: { invoiceId: string; payDate?: string }, opts: Opts = {}): Promise<ActionResult<PaymentRecord>> => {
    withDb(opts);
    return (await adminCannot(actor.userId, "schedule payments")) ?? schedulePayment(actor.userId, input);
  },
  release: async (actor: Actor, input: { paymentId: string }, opts: Opts = {}): Promise<ActionResult<PaymentRecord>> => {
    withDb(opts);
    return (await adminReleaseGuard(actor.userId, input.paymentId)) ?? releasePayment(actor.userId, input);
  },
  cancel: async (actor: Actor, input: { paymentId: string; reason: string }, opts: Opts = {}): Promise<ActionResult<PaymentRecord>> => {
    withDb(opts);
    return (await adminCannot(actor.userId, "cancel payments")) ?? cancelPayment(actor.userId, input);
  },
  settle: (actor: Actor, input: { paymentId: string; outcome: "SETTLED" | FailureCode }, opts: Opts = {}): Promise<ActionResult<PaymentRecord>> => (withDb(opts), simulateSettlement(actor.userId, input)),
  clearFlag: (actor: Actor, input: { flagId: string; note: string }, opts: Opts = {}): Promise<ActionResult<PaymentFlag>> => (withDb(opts), clearFlag(actor.userId, input)),
  requestBankChange: (actor: Actor, input: { vendorId: string; institution: string; transit: string; account: string }, opts: Opts = {}) => (withDb(opts), requestBankChange(actor.userId, input)),
  verifyBankChange: (actor: Actor, input: { vendorId: string }, opts: Opts = {}) => (withDb(opts), verifyBankChange(actor.userId, input)),
  rejectBankChange: (actor: Actor, input: { vendorId: string; reason: string }, opts: Opts = {}) => (withDb(opts), rejectBankChange(actor.userId, input)),
};
