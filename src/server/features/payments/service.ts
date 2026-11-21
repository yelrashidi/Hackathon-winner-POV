/**
 * Feature 7 — payments service. Every action: (1) the caller passes the signed-in person's id,
 * read from the server session, never from the request; (2) the rules in rules.ts decide;
 * (3) the change and its audit event are written together. A refusal returns every reason.
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
import type { DirectoryUser } from "@/server/features/approvals";
import { getEftRail } from "./bank";
import {
  addBankAccount,
  emitAudit,
  fireInvoiceEvent,
  flagRows,
  getApprovalFacts,
  getInvoice,
  getOpenInvoiceFlags,
  getReleasePolicies,
  getUser,
  getVendor,
  listAudit,
  listBankAccounts,
  listInvoices,
  nextId,
  paymentRows,
} from "./deps";
import {
  checkBankDecision,
  checkBankRequest,
  checkCancel,
  checkClearFlag,
  checkRelease,
  checkSchedule,
  defaultPayDate,
  flagMessage,
  type Reason,
} from "./rules";
import type { AuditEvent, FlagRec, InvoiceRec, PaymentRec } from "./types";

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

const payments = paymentRows;
const flags = flagRows;

function attemptsFor(invoiceId: string): PaymentRec[] {
  return payments().filter((p) => p.invoiceId === invoiceId).sort((a, b) => a.attemptNo - b.attemptNo);
}

function openFlagsFor(payment: PaymentRec): FlagRec[] {
  return flags().filter(
    (f) => f.clearedAt === null && ((f.scope === "supplier" && f.vendorId === payment.vendorId) || f.paymentId === payment.paymentId),
  );
}

function audit(actorId: string, now: Date, action: string, entityType: AuditEvent["entityType"], entityId: string, invoiceId: string | null, before: unknown, after: unknown, reason: string | null = null) {
  emitAudit({ occurredAt: now.toISOString(), actorId, onBehalfOf: null, action, entityType, entityId, invoiceId, before, after, reason });
}

// ---------------------------------------------------------------------------------------------
// Read side (what the dashboard calls)
// ---------------------------------------------------------------------------------------------

function person(userId: string): Person {
  return { userId, name: getUser(userId)?.fullName ?? userId };
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

function toFlag(f: FlagRec): PaymentFlag {
  return {
    flagId: f.flagId,
    urgency: f.urgency,
    reasonCode: f.reasonCode,
    message: f.message,
    scope: f.scope,
    vendorId: f.vendorId,
    paymentId: f.paymentId,
    createdAt: f.createdAt,
    clearedBy: f.clearedBy ? person(f.clearedBy) : null,
    clearedAt: f.clearedAt,
    clearNote: f.clearNote,
    clearedAutomatically: f.clearedAutomatically,
  };
}

function flagsForAttempt(p: PaymentRec): FlagRec[] {
  return flags()
    .filter((f) => (f.scope === "supplier" && f.vendorId === p.vendorId) || f.paymentId === p.paymentId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function toRecord(p: PaymentRec): PaymentRecord {
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
    cancelledBy: p.cancelledBy ? person(p.cancelledBy) : null,
    cancelReason: p.cancelReason,
    holdReason: p.holdReason,
    preparedBy: person(p.preparedBy),
    releasedBy: p.releasedBy ? person(p.releasedBy) : null,
    flags: flagsForAttempt(p).map(toFlag),
  });
}

function toInvoiceRecord(i: InvoiceRec): InvoiceRecord {
  const approval = getApprovalFacts(i.id);
  return {
    invoiceId: i.id,
    vendorInvoiceNumber: i.vendorInvoiceNumber,
    vendorId: i.vendorId,
    vendorName: getVendor(i.vendorId)?.legalName ?? i.vendorId,
    currency: i.currency,
    totalCents: i.totalCents,
    totalCadCents: i.totalCadCents,
    dueDate: i.dueDate,
    requestedBy: person(i.requesterId),
    approvedBy: [...new Set(approval?.approverIds ?? [])].map(person),
    status: i.status as InvoiceRecord["status"],
  };
}

function releaseInputFor(actor: DirectoryUser | undefined, p: PaymentRec, invoice: InvoiceRec) {
  return {
    actor,
    payment: p,
    invoice,
    vendor: getVendor(p.vendorId),
    bankAccounts: listBankAccounts(p.vendorId),
    approval: getApprovalFacts(invoice.id),
    paymentFlags: openFlagsFor(p),
    invoiceFlags: getOpenInvoiceFlags(invoice.id),
    policies: getReleasePolicies(),
  };
}

function toRow(viewer: DirectoryUser | undefined, invoice: InvoiceRec, attempts: PaymentRec[]): PaymentRow {
  const current = attempts[attempts.length - 1];
  const records = attempts.map(toRecord);
  const seen = new Set<string>();
  const rowFlags = records
    .flatMap((r) => r.flags)
    .filter((f) => (seen.has(f.flagId) ? false : (seen.add(f.flagId), true)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return {
    invoice: toInvoiceRecord(invoice),
    current: records[records.length - 1],
    attempts: records,
    flags: rowFlags,
    releaseCheck: checkRelease(releaseInputFor(viewer, current, invoice)),
  };
}

/** Every payment the signed-in person may see. */
export function listPayments(viewerId: string | null): PaymentsView {
  const viewer = viewerId ? getUser(viewerId) : undefined;
  const rows: PaymentRow[] = [];
  const awaiting: InvoiceRecord[] = [];
  for (const invoice of listInvoices()) {
    if (!canSee(viewer, invoice)) continue;
    const attempts = attemptsFor(invoice.id);
    if (attempts.length === 0) {
      if (invoice.status === "Approved") awaiting.push(toInvoiceRecord(invoice));
      continue;
    }
    rows.push(toRow(viewer, invoice, attempts));
  }
  rows.sort((a, b) => a.current.scheduledDate.localeCompare(b.current.scheduledDate));
  awaiting.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return { payments: rows, awaitingPayment: awaiting };
}

/** One invoice's payment, or null if it has none or the person may not see it. */
export function getPaymentDetail(viewerId: string | null, invoiceId: string): PaymentRow | null {
  const viewer = viewerId ? getUser(viewerId) : undefined;
  const invoice = getInvoice(invoiceId);
  if (!invoice || !canSee(viewer, invoice)) return null;
  const attempts = attemptsFor(invoiceId);
  return attempts.length ? toRow(viewer, invoice, attempts) : null;
}

/** The invoice's payment audit trail (who, when, what), oldest first. */
export function getPaymentAudit(viewerId: string | null, invoiceId: string): AuditEvent[] {
  const viewer = viewerId ? getUser(viewerId) : undefined;
  const invoice = getInvoice(invoiceId);
  if (!invoice || !canSee(viewer, invoice)) return [];
  const vendorId = invoice.vendorId;
  return listAudit().filter((e) => e.invoiceId === invoiceId || (e.entityType === "bank_account" && e.entityId.startsWith(`${vendorId}#`)));
}

/** A supplier's bank account versions, last 4 digits only. */
export function getSupplierBank(viewerId: string | null, vendorId: string) {
  if (!viewerId || !getUser(viewerId)) return [];
  return listBankAccounts(vendorId).map((a) => ({
    version: a.version,
    status: a.status,
    last4: a.last4,
    currency: a.currency,
    changedAt: a.changedAt,
    channel: a.channel,
    requestedBy: a.requestedBy ? person(a.requestedBy) : null,
    verifiedBy: a.verifiedBy ? person(a.verifiedBy) : null,
  }));
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

/** Schedule an approved invoice, or retry after a failed attempt (a new attempt, all checks again). */
export function schedulePayment(actorId: string | null, input: { invoiceId: string; payDate?: string }, opts: ActionOptions = {}): ActionResult<PaymentRecord> {
  const now = opts.now ?? new Date();
  const today = localDate(now);
  const actor = actorId ? getUser(actorId) : undefined;
  const invoice = getInvoice(input.invoiceId);
  if (!invoice) return notFound(`Invoice ${input.invoiceId}`);
  const attempts = attemptsFor(invoice.id);
  const payDate = input.payDate || defaultPayDate(invoice.dueDate, today);
  const check = checkSchedule({
    actor,
    invoice,
    vendor: getVendor(invoice.vendorId),
    attempts,
    bankAccounts: listBankAccounts(invoice.vendorId),
    supplierFlags: flags().filter((f) => f.vendorId === invoice.vendorId && f.scope === "supplier" && f.clearedAt === null),
    payDate,
    today,
  });
  if (!check.allowed || !check.account) return refuse(403, check.reasons);

  const p: PaymentRec = {
    paymentId: nextId("PAY"),
    invoiceId: invoice.id,
    vendorId: invoice.vendorId,
    attemptNo: attempts.length + 1,
    status: check.startsOnHold ? "on_hold" : "scheduled",
    method: "EFT",
    currency: invoice.currency,
    amountCents: invoice.totalCents,
    amountCadCents: invoice.totalCadCents,
    fxRateToCad: invoice.fxRate,
    scheduledDate: payDate,
    bankVersion: check.account.version,
    bankLast4: check.account.last4,
    releasedAt: null,
    settledAt: null,
    failedAt: null,
    failure: null,
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
    holdReason: check.startsOnHold ? flagMessage("critical", "FRAUD_HOLD", today) : null,
    preparedBy: actor!.id,
    releasedBy: null,
    bankReference: null,
  };
  payments().push(p);
  fireInvoiceEvent(invoice.id, "schedule", actor!.id, now);
  audit(actor!.id, now, attempts.length ? "payment.retried" : "payment.scheduled", "payment", p.paymentId, invoice.id, null, {
    attemptNo: p.attemptNo, status: p.status, amountCents: p.amountCents, currency: p.currency, scheduledDate: p.scheduledDate, bankLast4: p.bankLast4,
  });

  // Low flags clear themselves once the retry is scheduled.
  for (const f of flags()) {
    if (f.urgency === "low" && f.invoiceId === invoice.id && f.clearedAt === null) {
      f.clearedAt = now.toISOString();
      f.clearedAutomatically = true;
      audit(actor!.id, now, "payment_flag.cleared_automatically", "payment_flag", f.flagId, f.invoiceId, { open: true }, { open: false }, "Retry scheduled");
    }
  }
  return { ok: true, value: toRecord(p), warnings: check.warnings };
}

export function releasePayment(actorId: string | null, input: { paymentId: string }, opts: ActionOptions = {}): ActionResult<PaymentRecord> {
  const now = opts.now ?? new Date();
  const actor = actorId ? getUser(actorId) : undefined;
  const p = payments().find((x) => x.paymentId === input.paymentId);
  if (!p) return notFound(`Payment ${input.paymentId}`);
  const invoice = getInvoice(p.invoiceId);
  if (!invoice) return notFound(`Invoice ${p.invoiceId}`);
  const check = checkRelease(releaseInputFor(actor, p, invoice));
  if (!check.allowed) return refuse(403, check.reasons);

  const account = listBankAccounts(p.vendorId).find((a) => a.version === p.bankVersion)!;
  const { reference } = getEftRail().send({
    paymentId: p.paymentId, vendorId: p.vendorId, amountCents: p.amountCents, currency: p.currency,
    institution: account.institution, transit: account.transit, account: account.account, last4: account.last4,
  });
  p.status = "released";
  p.releasedAt = now.toISOString();
  p.releasedBy = actor!.id;
  p.bankReference = reference;
  audit(actor!.id, now, "payment.released", "payment", p.paymentId, p.invoiceId, { status: "scheduled" }, { status: "released", reference });
  return { ok: true, value: toRecord(p), warnings: [] };
}

export function cancelPayment(actorId: string | null, input: { paymentId: string; reason: string }, opts: ActionOptions = {}): ActionResult<PaymentRecord> {
  const now = opts.now ?? new Date();
  const actor = actorId ? getUser(actorId) : undefined;
  const p = payments().find((x) => x.paymentId === input.paymentId);
  if (!p) return notFound(`Payment ${input.paymentId}`);
  const reasons = checkCancel(actor, p, input.reason ?? "");
  if (reasons.length) return refuse(403, reasons);

  const before = p.status;
  p.status = "cancelled";
  p.cancelledAt = now.toISOString();
  p.cancelledBy = actor!.id;
  p.cancelReason = input.reason.trim();
  fireInvoiceEvent(p.invoiceId, "paymentCancelled", actor!.id, now);
  audit(actor!.id, now, "payment.cancelled", "payment", p.paymentId, p.invoiceId, { status: before }, { status: "cancelled" }, p.cancelReason);
  return { ok: true, value: toRecord(p), warnings: [] };
}

/** The simulated bank's answer for a released payment. Pressed by a person in the demo. */
export function simulateSettlement(actorId: string | null, input: { paymentId: string; outcome: "SETTLED" | FailureCode }, opts: ActionOptions = {}): ActionResult<PaymentRecord> {
  const now = opts.now ?? new Date();
  const today = localDate(now);
  const actor = actorId ? getUser(actorId) : undefined;
  const p = payments().find((x) => x.paymentId === input.paymentId);
  if (!p) return notFound(`Payment ${input.paymentId}`);
  if (!actor || !["ap_clerk", "finance_manager", "controller_admin"].includes(actor.role)) {
    return refuse(403, [{ code: "VIEW_ONLY", message: "Only finance staff can run the simulated bank." }]);
  }
  if (p.status !== "released") {
    return refuse(409, [{ code: "NOT_RELEASED", message: `This payment is ${p.status.replace("_", " ")}; the bank only answers for a released payment.` }]);
  }

  if (input.outcome === "SETTLED") {
    p.status = "settled";
    p.settledAt = now.toISOString();
    fireInvoiceEvent(p.invoiceId, "paymentSettled", actor.id, now);
    audit(actor.id, now, "payment.settled", "payment", p.paymentId, p.invoiceId, { status: "released" }, { status: "settled" }, "Simulated bank");
    return { ok: true, value: toRecord(p), warnings: [] };
  }

  const code = input.outcome;
  const reason = FAILURE_REASONS[code];
  if (!reason) return refuse(400, [{ code: "UNKNOWN_OUTCOME", message: `Unknown bank outcome ${code}.` }]);
  p.status = "failed";
  p.failedAt = now.toISOString();
  p.failure = { code, ...reason };
  fireInvoiceEvent(p.invoiceId, "paymentFailed", actor.id, now);
  audit(actor.id, now, "payment.failed", "payment", p.paymentId, p.invoiceId, { status: "released" }, { status: "failed", code }, "Simulated bank");

  const flag: FlagRec = {
    flagId: nextId("FLG"),
    urgency: reason.urgency,
    reasonCode: code,
    message: flagMessage(reason.urgency, code, today),
    scope: reason.urgency === "low" ? "payment" : "supplier",
    vendorId: p.vendorId,
    invoiceId: p.invoiceId,
    paymentId: p.paymentId,
    createdAt: now.toISOString(),
    clearedBy: null,
    clearedAt: null,
    clearNote: null,
    clearedAutomatically: false,
  };
  flags().push(flag);
  audit(actor.id, now, "payment_flag.created", "payment_flag", flag.flagId, p.invoiceId, null, { urgency: flag.urgency, scope: flag.scope, reasonCode: code });

  if (reason.urgency === "critical") {
    // Stop every other scheduled payment to this supplier.
    for (const other of payments()) {
      if (other.vendorId === p.vendorId && other.status === "scheduled") {
        other.status = "on_hold";
        other.holdReason = flag.message;
        audit(actor.id, now, "payment.on_hold", "payment", other.paymentId, other.invoiceId, { status: "scheduled" }, { status: "on_hold" }, flag.message);
      }
    }
  }
  if (reason.retryRule === "FIX_BANK_DETAILS") {
    // The account is dead for every payment, not just this one.
    const account = listBankAccounts(p.vendorId).find((a) => a.version === p.bankVersion);
    if (account && account.status !== "closed") {
      const before = account.status;
      account.status = "closed";
      account.closedReason = code;
      audit(actor.id, now, "bank_account.closed", "bank_account", `${p.vendorId}#${account.version}`, p.invoiceId, { status: before }, { status: "closed" }, reason.message);
    }
  }
  return { ok: true, value: toRecord(p), warnings: [] };
}

export function clearFlag(actorId: string | null, input: { flagId: string; note: string }, opts: ActionOptions = {}): ActionResult<PaymentFlag> {
  const now = opts.now ?? new Date();
  const actor = actorId ? getUser(actorId) : undefined;
  const f = flags().find((x) => x.flagId === input.flagId);
  if (!f) return notFound(`Flag ${input.flagId}`);
  const raisedBy = payments().find((x) => x.paymentId === f.paymentId);
  const reasons = checkClearFlag(actor, f, raisedBy?.preparedBy ?? null, input.note ?? "");
  if (reasons.length) return refuse(403, reasons);

  f.clearedAt = now.toISOString();
  f.clearedBy = actor!.id;
  f.clearNote = input.note?.trim() || null;
  audit(actor!.id, now, "payment_flag.cleared", "payment_flag", f.flagId, f.invoiceId, { open: true }, { open: false }, f.clearNote);

  if (f.urgency === "critical") {
    const stillCritical = flags().some((x) => x.vendorId === f.vendorId && x.urgency === "critical" && x.scope === "supplier" && x.clearedAt === null);
    if (!stillCritical) {
      for (const p of payments()) {
        if (p.vendorId === f.vendorId && p.status === "on_hold") {
          p.status = "scheduled";
          p.holdReason = null;
          audit(actor!.id, now, "payment.hold_released", "payment", p.paymentId, p.invoiceId, { status: "on_hold" }, { status: "scheduled" }, f.clearNote);
        }
      }
    }
  }
  return { ok: true, value: toFlag(f), warnings: [] };
}

export function requestBankChange(
  actorId: string | null,
  input: { vendorId: string; institution: string; transit: string; account: string },
  opts: ActionOptions = {},
): ActionResult<{ version: number; last4: string }> {
  const now = opts.now ?? new Date();
  const actor = actorId ? getUser(actorId) : undefined;
  if (!getVendor(input.vendorId)) return notFound(`Supplier ${input.vendorId}`);
  const existing = listBankAccounts(input.vendorId);
  const details = { institution: input.institution.trim(), transit: input.transit.trim(), account: input.account.replace(/\s/g, "") };
  const reasons = checkBankRequest(actor, existing, details);
  if (reasons.length) return refuse(403, reasons);

  const version = (existing[existing.length - 1]?.version ?? 0) + 1;
  const last4 = details.account.slice(-4);
  addBankAccount({
    vendorId: input.vendorId,
    version,
    status: "pending",
    institution: details.institution,
    transit: details.transit,
    account: details.account,
    last4,
    currency: "CAD",
    changedAt: localDate(now),
    channel: "entered_in_app",
    requestedBy: actor!.id,
    verifiedBy: null,
    verifiedAt: null,
    closedReason: null,
  });
  audit(actor!.id, now, "bank_account.change_requested", "bank_account", `${input.vendorId}#${version}`, null, null, { version, status: "pending", last4 });
  return { ok: true, value: { version, last4 }, warnings: [] };
}

export function verifyBankChange(actorId: string | null, input: { vendorId: string }, opts: ActionOptions = {}): ActionResult<{ version: number; last4: string }> {
  const now = opts.now ?? new Date();
  const actor = actorId ? getUser(actorId) : undefined;
  const accounts = listBankAccounts(input.vendorId);
  const pending = accounts.find((a) => a.status === "pending");
  const reasons = checkBankDecision(actor, pending, "verify");
  if (reasons.length || !pending) return refuse(403, reasons);

  for (const a of accounts) if (a.status === "verified") a.status = "superseded";
  pending.status = "verified";
  pending.verifiedBy = actor!.id;
  pending.verifiedAt = now.toISOString();
  audit(actor!.id, now, "bank_account.verified", "bank_account", `${input.vendorId}#${pending.version}`, null, { status: "pending" }, { status: "verified", last4: pending.last4 });

  // High flags on this supplier clear themselves once new details are verified.
  for (const f of flags()) {
    if (f.vendorId === input.vendorId && f.urgency === "high" && f.clearedAt === null) {
      f.clearedAt = now.toISOString();
      f.clearedAutomatically = true;
      audit(actor!.id, now, "payment_flag.cleared_automatically", "payment_flag", f.flagId, f.invoiceId, { open: true }, { open: false }, "New bank details verified");
    }
  }
  return { ok: true, value: { version: pending.version, last4: pending.last4 }, warnings: [] };
}

export function rejectBankChange(actorId: string | null, input: { vendorId: string; reason: string }, opts: ActionOptions = {}): ActionResult<{ version: number; last4: string }> {
  const now = opts.now ?? new Date();
  const actor = actorId ? getUser(actorId) : undefined;
  const pending = listBankAccounts(input.vendorId).find((a) => a.status === "pending");
  const reasons = checkBankDecision(actor, pending, "reject");
  if (reasons.length || !pending) return refuse(403, reasons);

  pending.status = "rejected";
  audit(actor!.id, now, "bank_account.rejected", "bank_account", `${input.vendorId}#${pending.version}`, null, { status: "pending" }, { status: "rejected", last4: pending.last4 }, input.reason?.trim() || null);
  return { ok: true, value: { version: pending.version, last4: pending.last4 }, warnings: [] };
}
