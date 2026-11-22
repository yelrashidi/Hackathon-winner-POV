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
 * Same calls as the service. P09–P11: the Finance Manager releases up to $100,000 CAD, the Controller
 * (our Admin, controller_admin) releases any amount, and nobody releases what they approved (the
 * service's checkRelease). The Admin does not schedule or cancel (AP Clerks prepare; P09 note).
 */

type Opts = { db?: Db };
type Refusal = Extract<ActionResult<never>, { ok: false }>;

/** Tests pass their database; the app uses getDb(). */
function withDb(opts: Opts) {
  if (opts.db) setDb(opts.db);
}

async function roleOf(userId: string): Promise<string | undefined> {
  const [u] = await getDb().select({ role: users.role }).from(users).where(eq(users.id, userId));
  return u?.role;
}

/** Who may release: the Finance Manager and the Controller, by the service's own release check. */
async function releasersFor(invoiceId: string): Promise<Person[]> {
  return eligibleReleasers(invoiceId);
}

async function adminCannot(actorId: string, what: string): Promise<Refusal | null> {
  if ((await roleOf(actorId)) !== "controller_admin") return null;
  return { ok: false, status: 403, reasons: [{ code: "ADMIN_NO_PAYMENTS", message: `The Admin doesn't ${what}: AP Clerks prepare payments and the Finance Manager releases them. The Admin releases them.` }] };
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
    return releasePayment(actor.userId, input);
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
