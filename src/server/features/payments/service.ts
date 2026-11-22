/**
 * Feature 7 — payments service. Every action: (1) the caller passes the signed-in person's id,
 * read from the server session, never from the request; (2) authorize() checks the role, then the
 * rules in rules.ts decide; (3) the change, the invoice status (fire()) and the audit events are
 * written in one transaction (withAction). A refusal returns every reason.
 */

import {
  FAILURE_REASONS,
  PaymentRecord,
  type FailureCode,
  type InvoiceRecord,
  type PaymentFlag,
  type PaymentRow,
  type PaymentsView,
  type Person,
} from "@/contracts/payment";
import { withAction, type ActionContext } from "@/server/core/audit";
import { authorize, Forbidden, type Action } from "@/server/core/authorize";
import { fire, pgCode, TransitionError } from "@/server/core/fire";
import { getDb, type Executor } from "@/server/db/client";
import type { DirectoryUser } from "@/server/features/approvals";
import { getEftRail } from "./bank";
import * as store from "./deps";
import {
  checkBankDecision,
  checkBankRequest,
  checkCancel,
  checkClearFlag,
  checkRelease,
  checkSchedule,
  defaultPayDate,
  FINANCE_ROLES,
  flagMessage,
  type ReleaseInput,
  type Reason,
} from "./rules";
import type { AuditEvent, FlagRec, InvoiceRec, PaymentRec, PaymentsData } from "./types";

export type ActionResult<T> =
  | { ok: true; value: T; warnings: string[] }
  | { ok: false; status: 400 | 403 | 404 | 409; reasons: Reason[] };

export interface ActionOptions {
  now?: Date;
}

const refuse = (status: 400 | 403 | 404 | 409, reasons: Reason[]): ActionResult<never> => ({ ok: false, status, reasons });
const notFound = (what: string) => refuse(404, [{ code: "NOT_FOUND", message: `${what} was not found.` }]);

/** Harborline's calendar day (Toronto), used for pay dates. */
export function localDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function attemptsFor(d: PaymentsData, invoiceId: string): PaymentRec[] {
  return d.attempts.filter((p) => p.invoiceId === invoiceId).sort((a, b) => a.attemptNo - b.attemptNo);
}

function openFlagsFor(d: PaymentsData, payment: PaymentRec): FlagRec[] {
  return d.flags.filter(
    (f) => f.clearedAt === null && ((f.scope === "supplier" && f.vendorId === payment.vendorId) || f.paymentId === payment.paymentId),
  );
}

// ---------------------------------------------------------------------------------------------
// Read side (what the dashboard calls)
// ---------------------------------------------------------------------------------------------

function person(people: Map<string, DirectoryUser>, userId: string): Person {
  return { userId, name: people.get(userId)?.fullName ?? userId };
}

/** Q10: who sees which invoices' payments. */
function canSee(viewer: DirectoryUser | undefined, invoice: InvoiceRec): boolean {
  if (!viewer) return false;
  switch (viewer.role) {
    case "employee":
      return invoice.requesterId === viewer.id;
    case "approver":
      return invoice.departmentId === viewer.departmentId;
    default:
      return true; // ap_clerk, finance_manager, controller_admin, auditor (read only)
  }
}

function toFlag(people: Map<string, DirectoryUser>, f: FlagRec): PaymentFlag {
  return {
    flagId: f.flagId,
    urgency: f.urgency,
    reasonCode: f.reasonCode,
    message: f.message,
    scope: f.scope,
    vendorId: f.vendorId,
    paymentId: f.paymentId,
    createdAt: f.createdAt,
    clearedBy: f.clearedBy ? person(people, f.clearedBy) : null,
    clearedAt: f.clearedAt,
    clearNote: f.clearNote,
    clearedAutomatically: f.clearedAutomatically,
  };
}

function flagsForAttempt(d: PaymentsData, p: PaymentRec): FlagRec[] {
  return d.flags
    .filter((f) => (f.scope === "supplier" && f.vendorId === p.vendorId) || f.paymentId === p.paymentId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function toRecord(d: PaymentsData, p: PaymentRec): PaymentRecord {
  return PaymentRecord.parse({
    paymentId: p.paymentId,
    invoiceId: p.invoiceId,
    attemptNo: p.attemptNo,
    status: p.status,
    method: p.method,
    currency: p.currency,
    amountCents: p.amountCents,
    amountCadCents: p.amountCadCents,
    fxRateToCad: p.fxRateToCad,
    scheduledDate: p.scheduledDate,
    bankAccount: { vendorId: p.vendorId, version: p.bankVersion, last4: p.bankLast4 },
    releasedAt: p.releasedAt,
    settledAt: p.settledAt,
    failedAt: p.failedAt,
    failure: p.failure,
    cancelledAt: p.cancelledAt,
    cancelledBy: p.cancelledBy ? person(d.users, p.cancelledBy) : null,
    cancelReason: p.cancelReason,
    holdReason: p.holdReason,
    preparedBy: person(d.users, p.preparedBy),
    releasedBy: p.releasedBy ? person(d.users, p.releasedBy) : null,
    flags: flagsForAttempt(d, p).map((f) => toFlag(d.users, f)),
  });
}

function toInvoiceRecord(d: PaymentsData, i: InvoiceRec): InvoiceRecord {
  const approval = d.approvals.get(i.id);
  return {
    invoiceId: i.id,
    vendorInvoiceNumber: i.vendorInvoiceNumber,
    vendorId: i.vendorId,
    vendorName: d.vendors.get(i.vendorId)?.legalName ?? i.vendorId,
    currency: i.currency,
    totalCents: i.totalCents,
    totalCadCents: i.totalCadCents,
    dueDate: i.dueDate,
    requestedBy: person(d.users, i.requesterId),
    approvedBy: [...new Set(approval?.approverIds ?? [])].map((id) => person(d.users, id)),
    status: i.status as InvoiceRecord["status"],
  };
}

function releaseInputFor(d: PaymentsData, actor: DirectoryUser | undefined, p: PaymentRec, invoice: InvoiceRec): ReleaseInput {
  return {
    actor,
    payment: p,
    invoice,
    vendor: d.vendors.get(p.vendorId),
    bankAccounts: d.bankAccounts.filter((a) => a.vendorId === p.vendorId),
    approval: d.approvals.get(invoice.id),
    paymentFlags: openFlagsFor(d, p),
    invoiceFlags: d.invoiceFlags.get(invoice.id) ?? [],
    policies: d.policies,
  };
}

function toRow(d: PaymentsData, viewer: DirectoryUser | undefined, invoice: InvoiceRec, attempts: PaymentRec[]): PaymentRow {
  const current = attempts[attempts.length - 1]!; // callers only pass invoices with an attempt
  const records = attempts.map((p) => toRecord(d, p));
  const seen = new Set<string>();
  const rowFlags = records
    .flatMap((r) => r.flags)
    .filter((f) => (seen.has(f.flagId) ? false : (seen.add(f.flagId), true)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return {
    invoice: toInvoiceRecord(d, invoice),
    current: records[records.length - 1]!,
    attempts: records,
    flags: rowFlags,
    releaseCheck: checkRelease(releaseInputFor(d, viewer, current, invoice)),
  };
}

/** Every payment the signed-in person may see. */
export async function listPayments(viewerId: string | null): Promise<PaymentsView> {
  const d = await store.loadData(getDb(), { today: () => localDate(new Date()) });
  const viewer = viewerId ? d.users.get(viewerId) : undefined;
  const rows: PaymentRow[] = [];
  const awaiting: InvoiceRecord[] = [];
  for (const invoice of d.invoices) {
    if (!canSee(viewer, invoice)) continue;
    const attempts = attemptsFor(d, invoice.id);
    if (attempts.length === 0) {
      if (invoice.status === "Approved") awaiting.push(toInvoiceRecord(d, invoice));
      continue;
    }
    rows.push(toRow(d, viewer, invoice, attempts));
  }
  rows.sort((a, b) => a.current.scheduledDate.localeCompare(b.current.scheduledDate));
  awaiting.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return { payments: rows, awaitingPayment: awaiting };
}

/** One invoice's payment, or null if it has none or the person may not see it. */
export async function getPaymentDetail(viewerId: string | null, invoiceId: string): Promise<PaymentRow | null> {
  const d = await store.loadData(getDb(), { invoiceId, today: () => localDate(new Date()) });
  const viewer = viewerId ? d.users.get(viewerId) : undefined;
  const invoice = d.invoices[0];
  if (!invoice || !canSee(viewer, invoice)) return null;
  const attempts = attemptsFor(d, invoiceId);
  return attempts.length ? toRow(d, viewer, invoice, attempts) : null;
}

/** Everyone who could release this invoice's current payment right now, by the same rules release uses. */
export async function eligibleReleasers(invoiceId: string): Promise<Person[]> {
  const d = await store.loadData(getDb(), { invoiceId, today: () => localDate(new Date()) });
  const invoice = d.invoices[0];
  const current = attemptsFor(d, invoiceId).at(-1);
  if (!invoice || !current) return [];
  const out: Person[] = [];
  for (const u of d.users.values()) {
    if (u.role !== "finance_manager" && u.role !== "controller_admin") continue;
    if (checkRelease(releaseInputFor(d, u, current, invoice)).allowed) out.push(person(d.users, u.id));
  }
  return out;
}

/** Whether this person may clear this flag, by the same rule clearFlag() enforces. */
export async function canClearFlag(viewerId: string | null, flagId: string): Promise<boolean> {
  const db = getDb();
  const found = await store.findFlag(db, flagId, false);
  if (!found) return false;
  const actor = viewerId ? await store.getUser(db, viewerId) : undefined;
  // The note is typed when clearing; check everything else.
  return checkClearFlag(actor, found.flag, found.scheduledBy, "note").length === 0;
}

/** The invoice's payment audit trail (who, when, what), oldest first. */
export async function getPaymentAudit(viewerId: string | null, invoiceId: string): Promise<AuditEvent[]> {
  const db = getDb();
  const [invoice] = await store.loadInvoices(db, { invoiceId, today: () => localDate(new Date()) });
  const viewer = viewerId ? await store.getUser(db, viewerId) : undefined;
  if (!invoice || !canSee(viewer, invoice)) return [];
  return store.loadPaymentAudit(db, invoiceId, invoice.vendorId);
}

/** A supplier's bank account versions, last 4 digits only. */
export async function getSupplierBank(viewerId: string | null, vendorId: string) {
  const db = getDb();
  const people = await store.loadUsers(db);
  if (!viewerId || !people.get(viewerId)) return [];
  return (await store.loadBankAccounts(db, [vendorId])).map((a) => ({
    version: a.version,
    status: a.status,
    last4: a.last4,
    currency: a.currency,
    changedAt: a.changedAt,
    channel: a.channel,
    requestedBy: a.requestedBy ? person(people, a.requestedBy) : null,
    verifiedBy: a.verifiedBy ? person(people, a.verifiedBy) : null,
  }));
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

/** What an action decided: a refusal, or the writes to make inside the transaction. */
type Decision<T> = ActionResult<T> | ((ctx: ActionContext) => Promise<ActionResult<T>>);

/**
 * authorize() first, outside the transaction (BUG-Andrew-04). Allowed: load, check and write in
 * one transaction, with the row the action is about locked. Not allowed: the same checks run
 * read-only, so the refusal still lists every reason, and nothing is written.
 */
async function perform<T>(
  actorId: string | null,
  action: Action,
  decide: (exec: Executor, actor: DirectoryUser | undefined, lock: boolean) => Promise<Decision<T>>,
): Promise<ActionResult<T>> {
  const db = getDb();
  const actor = actorId ? await store.getUser(db, actorId) : undefined;
  let authorized: ActionContext["actor"] | null = null;
  let denied = "You are not signed in.";
  if (actor) {
    try {
      authorized = authorize({ userId: actor.id, role: actor.role, onBehalfOf: null }, action).actor;
    } catch (err) {
      if (!(err instanceof Forbidden)) throw err;
      denied = err.reason;
    }
  }
  if (!authorized) {
    const decision = await decide(db, actor, false);
    return typeof decision === "function" ? refuse(403, [{ code: "FORBIDDEN", message: denied }]) : decision;
  }
  try {
    return await withAction(
      authorized,
      async (ctx) => {
        const decision = await decide(ctx.tx, actor, true);
        return typeof decision === "function" ? decision(ctx) : decision;
      },
      { db },
    );
  } catch (err) {
    if (err instanceof TransitionError) return refuse(409, [{ code: "CONFLICT", message: err.message }]);
    if (pgCode(err) === "23505") return refuse(409, [{ code: "CONFLICT", message: "Someone else changed this payment at the same moment. Reload and try again." }]);
    throw err;
  }
}

/** The payment as stored after the writes, read in the same transaction. */
async function recordOf(exec: Executor, invoiceId: string, paymentId: string, today: string): Promise<PaymentRecord> {
  const d = await store.loadData(exec, { invoiceId, today: () => today });
  return toRecord(d, d.attempts.find((p) => p.paymentId === paymentId)!);
}

/** Load the payment an action is about, its invoice and everything the rules need. */
async function loadForPayment(exec: Executor, paymentId: string, today: string, lock: boolean) {
  const ref = await store.findPayment(exec, paymentId, lock);
  if (!ref) return null;
  const d = await store.loadData(exec, { invoiceId: ref.invoiceId, today: () => today });
  const p = d.attempts.find((x) => x.paymentId === paymentId);
  const invoice = d.invoices[0];
  return p && invoice ? { d, p, invoice } : null;
}

/** Schedule an approved invoice, or retry after a failed attempt (a new attempt, all checks again). */
export async function schedulePayment(actorId: string | null, input: { invoiceId: string; payDate?: string }, opts: ActionOptions = {}): Promise<ActionResult<PaymentRecord>> {
  const now = opts.now ?? new Date();
  const today = localDate(now);
  return perform(actorId, "payment.prepare", async (exec, actor, lock) => {
    if (lock) await store.lockInvoice(exec, input.invoiceId);
    const d = await store.loadData(exec, { invoiceId: input.invoiceId, today: () => today });
    const invoice = d.invoices[0];
    if (!invoice) return notFound(`Invoice ${input.invoiceId}`);
    const attempts = attemptsFor(d, invoice.id);
    const payDate = input.payDate || defaultPayDate(invoice.dueDate, today);
    const check = checkSchedule({
      actor,
      invoice,
      vendor: d.vendors.get(invoice.vendorId),
      attempts,
      bankAccounts: d.bankAccounts.filter((a) => a.vendorId === invoice.vendorId),
      supplierFlags: d.flags.filter((f) => f.vendorId === invoice.vendorId && f.scope === "supplier" && f.clearedAt === null),
      payDate,
      today,
    });
    const account = check.account;
    if (!check.allowed || !account) return refuse(403, check.reasons);

    return async (ctx) => {
      const by = ctx.actor.userId;
      const paymentId = await store.nextPaymentId(ctx.tx);
      const attemptNo = attempts.length + 1;
      const status = check.startsOnHold ? "on_hold" : "scheduled";
      await store.insertPayment(ctx.tx, {
        id: paymentId,
        invoiceId: invoice.id,
        attemptNo,
        vendorId: invoice.vendorId,
        bankAccountId: account.accountId!,
        method: "EFT",
        scheduledDate: payDate,
        currency: invoice.currency,
        amountCents: invoice.totalCents,
        fxRate: invoice.fxRate,
        amountCadCents: invoice.totalCadCents,
        status,
        preparedBy: by,
        holdReason: check.startsOnHold ? flagMessage("critical", "FRAUD_HOLD", today) : null,
      });
      await fire(ctx, invoice.id, "schedule");
      await ctx.audit({
        action: attempts.length ? "payment.retried" : "payment.scheduled",
        entityType: "payment",
        entityId: paymentId,
        invoiceId: invoice.id,
        paymentId,
        after: { attemptNo, status, amountCents: invoice.totalCents, currency: invoice.currency, scheduledDate: payDate, bankLast4: account.last4 },
      });

      // Low flags clear themselves once the retry is scheduled.
      for (const f of d.flags) {
        if (f.urgency === "low" && f.invoiceId === invoice.id && f.clearedAt === null) {
          await store.updateFlag(ctx.tx, f.flagId, { clearedAt: now.toISOString(), clearedAutomatically: true });
          await ctx.audit({ action: "payment_flag.cleared_automatically", entityType: "payment_flag", entityId: f.flagId, invoiceId: f.invoiceId, paymentId: f.paymentId, before: { open: true }, after: { open: false }, reason: "Retry scheduled" });
        }
      }
      return { ok: true, value: await recordOf(ctx.tx, invoice.id, paymentId, today), warnings: check.warnings };
    };
  });
}

export async function releasePayment(actorId: string | null, input: { paymentId: string }, opts: ActionOptions = {}): Promise<ActionResult<PaymentRecord>> {
  const now = opts.now ?? new Date();
  const today = localDate(now);
  return perform(actorId, "payment.release", async (exec, actor, lock) => {
    const found = await loadForPayment(exec, input.paymentId, today, lock);
    if (!found) return notFound(`Payment ${input.paymentId}`);
    const { d, p, invoice } = found;
    const check = checkRelease(releaseInputFor(d, actor, p, invoice));
    if (!check.allowed) return refuse(403, check.reasons);

    return async (ctx) => {
      const account = d.bankAccounts.find((a) => a.vendorId === p.vendorId && a.version === p.bankVersion)!;
      const { reference } = getEftRail().send({
        paymentId: p.paymentId, vendorId: p.vendorId, amountCents: p.amountCents, currency: p.currency,
        institution: account.institution, transit: account.transit, account: account.account, last4: account.last4,
      });
      await store.updatePayment(ctx.tx, p.paymentId, { status: "released", releasedAt: now.toISOString(), releasedBy: ctx.actor.userId, reference });
      await ctx.audit({ action: "payment.released", entityType: "payment", entityId: p.paymentId, invoiceId: p.invoiceId, paymentId: p.paymentId, before: { status: "scheduled" }, after: { status: "released", reference } });
      return { ok: true, value: await recordOf(ctx.tx, invoice.id, p.paymentId, today), warnings: [] };
    };
  });
}

export async function cancelPayment(actorId: string | null, input: { paymentId: string; reason: string }, opts: ActionOptions = {}): Promise<ActionResult<PaymentRecord>> {
  const now = opts.now ?? new Date();
  const today = localDate(now);
  return perform(actorId, "payment.prepare", async (exec, actor, lock) => {
    const found = await loadForPayment(exec, input.paymentId, today, lock);
    if (!found) return notFound(`Payment ${input.paymentId}`);
    const { p, invoice } = found;
    const reasons = checkCancel(actor, p, input.reason ?? "");
    if (reasons.length) return refuse(403, reasons);

    return async (ctx) => {
      const reason = input.reason.trim();
      await store.updatePayment(ctx.tx, p.paymentId, { status: "cancelled", cancelledAt: now.toISOString(), cancelledBy: ctx.actor.userId, cancelReason: reason });
      await fire(ctx, p.invoiceId, "paymentCancelled");
      await ctx.audit({ action: "payment.cancelled", entityType: "payment", entityId: p.paymentId, invoiceId: p.invoiceId, paymentId: p.paymentId, before: { status: p.status }, after: { status: "cancelled" }, reason });
      return { ok: true, value: await recordOf(ctx.tx, invoice.id, p.paymentId, today), warnings: [] };
    };
  });
}

/** The simulated bank's answer for a released payment. Pressed by a person in the demo. */
export async function simulateSettlement(actorId: string | null, input: { paymentId: string; outcome: "SETTLED" | FailureCode }, opts: ActionOptions = {}): Promise<ActionResult<PaymentRecord>> {
  const now = opts.now ?? new Date();
  const today = localDate(now);
  return perform(actorId, "payment.prepare", async (exec, actor, lock) => {
    const found = await loadForPayment(exec, input.paymentId, today, lock);
    if (!found) return notFound(`Payment ${input.paymentId}`);
    const { d, p, invoice } = found;
    if (!actor || !FINANCE_ROLES.has(actor.role)) {
      return refuse(403, [{ code: "VIEW_ONLY", message: "Only finance staff can run the simulated bank." }]);
    }
    if (p.status !== "released") {
      return refuse(409, [{ code: "NOT_RELEASED", message: `This payment is ${p.status.replace("_", " ")}; the bank only answers for a released payment.` }]);
    }

    if (input.outcome === "SETTLED") {
      return async (ctx) => {
        await store.updatePayment(ctx.tx, p.paymentId, { status: "settled", settledAt: now.toISOString(), paidDate: today });
        await fire(ctx, p.invoiceId, "paymentSettled", { fullyPaid: true });
        await ctx.audit({ action: "payment.settled", entityType: "payment", entityId: p.paymentId, invoiceId: p.invoiceId, paymentId: p.paymentId, before: { status: "released" }, after: { status: "settled" }, reason: "Simulated bank" });
        return { ok: true, value: await recordOf(ctx.tx, invoice.id, p.paymentId, today), warnings: [] };
      };
    }

    const code = input.outcome;
    const reason = FAILURE_REASONS[code];
    if (!reason) return refuse(400, [{ code: "UNKNOWN_OUTCOME", message: `Unknown bank outcome ${code}.` }]);
    return async (ctx) => {
      await store.updatePayment(ctx.tx, p.paymentId, { status: "failed", failedAt: now.toISOString(), failureCode: code, failure: { code, ...reason } });
      await fire(ctx, p.invoiceId, "paymentFailed");
      await ctx.audit({ action: "payment.failed", entityType: "payment", entityId: p.paymentId, invoiceId: p.invoiceId, paymentId: p.paymentId, before: { status: "released" }, after: { status: "failed", code }, reason: "Simulated bank" });

      const message = flagMessage(reason.urgency, code, today);
      const scope = reason.urgency === "low" ? "payment" : "supplier";
      const flagId = await store.insertFlag(ctx.tx, { urgency: reason.urgency, reasonCode: code, message, scope, vendorId: p.vendorId, paymentId: p.paymentId, createdAt: now.toISOString() });
      await ctx.audit({ action: "payment_flag.created", entityType: "payment_flag", entityId: flagId, invoiceId: p.invoiceId, paymentId: p.paymentId, after: { urgency: reason.urgency, scope, reasonCode: code } });

      if (reason.urgency === "critical") {
        // Stop every other scheduled payment to this supplier.
        for (const held of await store.holdScheduledPayments(ctx.tx, p.vendorId, message)) {
          await ctx.audit({ action: "payment.on_hold", entityType: "payment", entityId: held.paymentId, invoiceId: held.invoiceId, paymentId: held.paymentId, before: { status: "scheduled" }, after: { status: "on_hold" }, reason: message });
        }
      }
      if (reason.retryRule === "FIX_BANK_DETAILS") {
        // The account is dead for every payment, not just this one.
        const account = d.bankAccounts.find((a) => a.vendorId === p.vendorId && a.version === p.bankVersion);
        if (account && account.status !== "closed") {
          await store.updateBankAccount(ctx.tx, account.accountId!, { status: "closed" });
          await ctx.audit({ action: "bank_account.closed", entityType: "bank_account", entityId: `${p.vendorId}#${account.version}`, invoiceId: p.invoiceId, paymentId: p.paymentId, before: { status: account.status }, after: { status: "closed" }, reason: reason.message });
        }
      }
      return { ok: true, value: await recordOf(ctx.tx, invoice.id, p.paymentId, today), warnings: [] };
    };
  });
}

export async function clearFlag(actorId: string | null, input: { flagId: string; note: string }, opts: ActionOptions = {}): Promise<ActionResult<PaymentFlag>> {
  const now = opts.now ?? new Date();
  return perform(actorId, "payment.prepare", async (exec, actor, lock) => {
    const found = await store.findFlag(exec, input.flagId, lock);
    if (!found) return notFound(`Flag ${input.flagId}`);
    const f = found.flag;
    const reasons = checkClearFlag(actor, f, found.scheduledBy, input.note ?? "");
    if (reasons.length) return refuse(403, reasons);

    return async (ctx) => {
      const note = input.note?.trim() || null;
      const cleared: FlagRec = { ...f, clearedAt: now.toISOString(), clearedBy: ctx.actor.userId, clearNote: note };
      await store.updateFlag(ctx.tx, f.flagId, { clearedAt: cleared.clearedAt, clearedBy: cleared.clearedBy, clearNote: note });
      await ctx.audit({ action: "payment_flag.cleared", entityType: "payment_flag", entityId: f.flagId, invoiceId: f.invoiceId, paymentId: f.paymentId, before: { open: true }, after: { open: false }, reason: note });

      if (f.urgency === "critical" && !(await store.hasOpenCriticalFlag(ctx.tx, f.vendorId))) {
        for (const p of await store.releaseHolds(ctx.tx, f.vendorId)) {
          await ctx.audit({ action: "payment.hold_released", entityType: "payment", entityId: p.paymentId, invoiceId: p.invoiceId, paymentId: p.paymentId, before: { status: "on_hold" }, after: { status: "scheduled" }, reason: note });
        }
      }
      return { ok: true, value: toFlag(await store.loadUsers(ctx.tx), cleared), warnings: [] };
    };
  });
}

export async function requestBankChange(
  actorId: string | null,
  input: { vendorId: string; institution: string; transit: string; account: string },
  opts: ActionOptions = {},
): Promise<ActionResult<{ version: number; last4: string }>> {
  const now = opts.now ?? new Date();
  return perform(actorId, "vendor.bank_change.request", async (exec, actor, lock) => {
    if (lock) await store.lockVendor(exec, input.vendorId);
    if (!(await store.getVendor(exec, input.vendorId))) return notFound(`Supplier ${input.vendorId}`);
    const existing = await store.loadBankAccounts(exec, [input.vendorId]);
    const details = { institution: input.institution.trim(), transit: input.transit.trim(), account: input.account.replace(/\s/g, "") };
    const reasons = checkBankRequest(actor, existing, details);
    if (reasons.length) return refuse(403, reasons);

    return async (ctx) => {
      const version = (existing[existing.length - 1]?.version ?? 0) + 1;
      const last4 = details.account.slice(-4);
      await store.insertBankAccount(ctx.tx, {
        vendorId: input.vendorId,
        version,
        status: "pending",
        currency: "CAD",
        institution: details.institution,
        transit: details.transit,
        account: details.account,
        last4,
        changedAt: localDate(now),
        channel: "entered_in_app",
        requestedBy: ctx.actor.userId,
      });
      await ctx.audit({ action: "bank_account.change_requested", entityType: "bank_account", entityId: `${input.vendorId}#${version}`, after: { version, status: "pending", last4 } });
      return { ok: true, value: { version, last4 }, warnings: [] };
    };
  });
}

export async function verifyBankChange(actorId: string | null, input: { vendorId: string }, opts: ActionOptions = {}): Promise<ActionResult<{ version: number; last4: string }>> {
  const now = opts.now ?? new Date();
  return perform(actorId, "vendor.bank_change.verify", async (exec, actor, lock) => {
    if (lock) await store.lockVendor(exec, input.vendorId);
    const accounts = await store.loadBankAccounts(exec, [input.vendorId]);
    const pending = accounts.find((a) => a.status === "pending");
    const reasons = checkBankDecision(actor, pending, "verify");
    if (reasons.length || !pending) return refuse(403, reasons);

    return async (ctx) => {
      // Supersede first: at most one verified account per supplier, checked by the database.
      for (const a of accounts) if (a.status === "verified") await store.updateBankAccount(ctx.tx, a.accountId!, { status: "superseded" });
      await store.updateBankAccount(ctx.tx, pending.accountId!, { status: "verified", verifiedBy: ctx.actor.userId, verifiedAt: now.toISOString() });
      await ctx.audit({ action: "bank_account.verified", entityType: "bank_account", entityId: `${input.vendorId}#${pending.version}`, before: { status: "pending" }, after: { status: "verified", last4: pending.last4 } });

      // High flags on this supplier clear themselves once new details are verified.
      for (const f of await store.loadFlags(ctx.tx, [input.vendorId])) {
        if (f.urgency === "high" && f.clearedAt === null) {
          await store.updateFlag(ctx.tx, f.flagId, { clearedAt: now.toISOString(), clearedAutomatically: true });
          await ctx.audit({ action: "payment_flag.cleared_automatically", entityType: "payment_flag", entityId: f.flagId, invoiceId: f.invoiceId, paymentId: f.paymentId, before: { open: true }, after: { open: false }, reason: "New bank details verified" });
        }
      }
      return { ok: true, value: { version: pending.version, last4: pending.last4 }, warnings: [] };
    };
  });
}

// Same options as every action; nothing here is timestamped (the audit row's time comes from the database).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function rejectBankChange(actorId: string | null, input: { vendorId: string; reason: string }, _opts: ActionOptions = {}): Promise<ActionResult<{ version: number; last4: string }>> {
  return perform(actorId, "vendor.bank_change.verify", async (exec, actor, lock) => {
    if (lock) await store.lockVendor(exec, input.vendorId);
    const pending = (await store.loadBankAccounts(exec, [input.vendorId])).find((a) => a.status === "pending");
    const reasons = checkBankDecision(actor, pending, "reject");
    if (reasons.length || !pending) return refuse(403, reasons);

    return async (ctx) => {
      await store.updateBankAccount(ctx.tx, pending.accountId!, { status: "rejected" });
      await ctx.audit({ action: "bank_account.rejected", entityType: "bank_account", entityId: `${input.vendorId}#${pending.version}`, before: { status: "pending" }, after: { status: "rejected", last4: pending.last4 }, reason: input.reason?.trim() || null });
      return { ok: true, value: { version: pending.version, last4: pending.last4 }, warnings: [] };
    };
  });
}
