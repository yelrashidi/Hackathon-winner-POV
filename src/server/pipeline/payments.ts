import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Actor } from "@/contracts/actor";
import { ApprovalPolicy } from "@/contracts/approvals";
import type { AuditEventInput } from "@/contracts/audit";
import type { Flag } from "@/contracts/flag";
import type { Currency, FailureCode, PaymentFailure, PaymentFlag, PaymentMethod, PaymentRecord, PaymentRow, PaymentStatus, PaymentsView, Person } from "@/contracts/payment";
import { withAction, type ActionContext } from "@/server/core/audit";
import { fire, TransitionError, type InvoiceEvent } from "@/server/core/fire";
import { getDb, type Db, type Executor } from "@/server/db/client";
import { approvalPolicies, auditEvents, invoiceFlags, invoices, paymentFlags, payments, users, vendorBankAccounts, vendors } from "@/server/db/schema";
import { approversOf, getApprovalPlans, getCurrentApprovalPlan, type DirectoryUser, type UserRole } from "@/server/features/approvals";
import {
  canClearFlag,
  cancelPayment,
  clearFlag,
  eligibleReleasers,
  getPaymentAudit,
  getPaymentDetail,
  getSupplierBank,
  listPayments,
  listUsers,
  rejectBankChange,
  releasePayment,
  requestBankChange,
  runWithState,
  schedulePayment,
  simulateSettlement,
  verifyBankChange,
  type ActionResult,
  type ApprovalFacts,
  type AuditEvent,
  type BankAccountVersion,
  type FlagRec,
  type InvoiceRec,
  type PaymentRec,
  type PaymentsState,
} from "@/server/features/payments";
import { PostgresApprovalStore } from "./approvals";

/**
 * Feature 7 (payments, Katie's rules + service) on the database.
 *
 * Katie's service works on one in-memory PaymentsState. Here every call gets its OWN state, loaded
 * from Postgres, and every action writes what changed back — in one transaction with its audit rows
 * and fire():
 *
 *   read(viewer)      load → run the service's read function → nothing written
 *   act(actor, fn)    BEGIN → load (inside the transaction) → run the action on the copy →
 *                     diff before/after → INSERT/UPDATE payments, payment_flags, vendor_bank_accounts
 *                     → fire() each invoice event the action raised (schedule, paymentSettled, …)
 *                     → audit_events for each event it recorded → COMMIT
 *
 * The rules (rules.ts) never change: the release check, separation of duties, bank two-person
 * rule and urgency flags all run exactly as in Katie's tests. What this file adds is only where the
 * data lives, plus one rule from the brief the dashboard needs (adminReleaseGuard below).
 *
 * What is loaded: the OPEN work — invoices Approved or PaymentScheduled — plus every invoice whose
 * payment was scheduled in the app (history paid before the import stays in the audit trail, not here).
 */

type Opts = { db?: Db };
const iso = (v: string | Date | null | undefined) => (v === null || v === undefined ? null : new Date(v).toISOString());
const OPEN_STATUSES = ["Approved", "PaymentScheduled"];

// ---------------------------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------------------------

/** Ids of invoices whose payment was scheduled in the app (not imported history). */
async function liveInvoiceIds(db: Executor): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: auditEvents.invoiceId })
    .from(auditEvents)
    .where(and(inArray(auditEvents.action, ["payment.scheduled", "payment.retried"]), sql`coalesce((${auditEvents.metadata}->>'imported')::boolean, false) = false`));
  return rows.map((r) => r.id).filter((x): x is string => x !== null);
}

export async function loadPaymentsState(db: Executor, opts: { auditFor?: { invoiceId: string } } = {}): Promise<PaymentsState> {
  const live = await liveInvoiceIds(db);
  const [userRows, vendorRows, invoiceRows, bankRows, policyRows] = await Promise.all([
    db.select().from(users).where(sql`${users.role} <> 'system'`),
    db.select().from(vendors),
    db
      .select()
      .from(invoices)
      .where(live.length ? or(inArray(invoices.status, OPEN_STATUSES), inArray(invoices.id, live)) : inArray(invoices.status, OPEN_STATUSES)),
    db.select().from(vendorBankAccounts).orderBy(asc(vendorBankAccounts.vendorId), asc(vendorBankAccounts.version)),
    db.select().from(approvalPolicies).where(eq(approvalPolicies.ruleType, "payment_release")).orderBy(asc(approvalPolicies.id), desc(approvalPolicies.version)),
  ]);

  const usersById = new Map<string, DirectoryUser>(
    userRows.map((u) => [
      u.id,
      {
        id: u.id,
        fullName: u.fullName,
        role: u.role as UserRole,
        departmentId: u.departmentId ?? "",
        managerId: u.managerId,
        approvalLimitCents: u.approvalLimitCents,
        status: u.status,
        statusSince: u.statusSince,
        delegateId: u.delegateId,
      },
    ]),
  );
  const vendorsById = new Map(vendorRows.map((v) => [v.id, { id: v.id, legalName: v.legalName, status: v.status }]));
  const bankById = new Map(bankRows.map((b) => [b.id, b]));
  const bankAccounts: BankAccountVersion[] = bankRows.map((b) => ({
    vendorId: b.vendorId,
    version: b.version,
    status: b.status as BankAccountVersion["status"],
    institution: b.institution,
    transit: b.transit,
    account: b.account,
    last4: b.last4,
    currency: b.currency as Currency,
    changedAt: b.changedAt,
    channel: b.channel,
    requestedBy: b.requestedBy,
    verifiedBy: b.verifiedBy,
    verifiedAt: iso(b.verifiedAt),
    closedReason: null,
  }));

  const candidateIds = invoiceRows.map((i) => i.id);
  const payRows = candidateIds.length ? await db.select().from(payments).where(inArray(payments.invoiceId, candidateIds)).orderBy(asc(payments.attemptNo)) : [];
  const nonEft = new Set(payRows.filter((p) => p.method !== "EFT" || p.bankAccountId === null).map((p) => p.invoiceId));

  const invoicesById = new Map<string, InvoiceRec>();
  for (const i of invoiceRows) {
    // EFT only, as in the in-memory loader (cheque and card payments are payment-todo.md).
    if (!i.vendorId || !i.currency || i.totalCents === null || i.totalCadCents === null || nonEft.has(i.id)) continue;
    invoicesById.set(i.id, {
      id: i.id,
      version: i.version,
      status: i.status,
      vendorId: i.vendorId,
      vendorInvoiceNumber: i.invoiceNumber ?? i.id,
      invoiceDate: i.invoiceDate ?? "",
      dueDate: i.dueDate ?? i.invoiceDate ?? "",
      currency: i.currency as Currency,
      totalCents: i.totalCents,
      totalCadCents: i.totalCadCents,
      fxRate: i.fxRate ?? "1",
      departmentId: i.departmentId ?? "",
      requesterId: i.requesterId ?? "",
      isCreditNote: i.isCreditNote,
    });
  }
  const ids = [...invoicesById.keys()];

  const paymentRecs: PaymentRec[] = payRows
    .filter((p) => invoicesById.has(p.invoiceId))
    .map((p) => {
      const bank = bankById.get(p.bankAccountId!)!;
      return {
        paymentId: p.id,
        invoiceId: p.invoiceId,
        vendorId: p.vendorId ?? invoicesById.get(p.invoiceId)!.vendorId,
        attemptNo: p.attemptNo,
        status: p.status as PaymentStatus,
        method: p.method as PaymentMethod,
        currency: p.currency as Currency,
        amountCents: p.amountCents,
        amountCadCents: p.amountCadCents,
        fxRateToCad: p.fxRate ?? "1",
        scheduledDate: p.scheduledDate ?? "",
        bankVersion: bank.version,
        bankLast4: bank.last4,
        releasedAt: iso(p.releasedAt),
        settledAt: iso(p.settledAt),
        failedAt: iso(p.failedAt),
        failure: (p.failure as PaymentFailure | null) ?? null,
        cancelledAt: iso(p.cancelledAt),
        cancelledBy: p.cancelledBy,
        cancelReason: p.cancelReason,
        holdReason: p.holdReason,
        preparedBy: p.preparedBy ?? "",
        releasedBy: p.releasedBy,
        bankReference: p.reference,
      };
    });

  const invoiceOfPayment = new Map(payRows.map((p) => [p.id, p.invoiceId]));
  const flagRows = await db.select().from(paymentFlags).orderBy(asc(paymentFlags.createdAt));
  const flagRecs: FlagRec[] = flagRows.map((f) => ({
    flagId: f.id,
    urgency: f.urgency as FlagRec["urgency"],
    reasonCode: f.reasonCode as FailureCode,
    message: f.message,
    scope: f.scope as FlagRec["scope"],
    vendorId: f.vendorId,
    invoiceId: invoiceOfPayment.get(f.paymentId) ?? "",
    paymentId: f.paymentId,
    createdAt: iso(f.createdAt)!,
    clearedBy: f.clearedBy,
    clearedAt: iso(f.clearedAt),
    clearNote: f.clearNote,
    clearedAutomatically: f.clearedAutomatically,
  }));

  // Open validation / duplicate flags: release refuses while a blocking one is open.
  const openFlags = new Map<string, Flag[]>();
  if (ids.length) {
    const rows = await db.select().from(invoiceFlags).where(and(inArray(invoiceFlags.invoiceId, ids), eq(invoiceFlags.status, "open")));
    for (const f of rows) {
      const list = openFlags.get(f.invoiceId) ?? [];
      list.push({ code: f.code, severity: f.severity as Flag["severity"], message: f.message, evidence: (f.evidence ?? {}) as Record<string, unknown>, status: "open", resolvedBy: null, resolutionNote: null });
      openFlags.set(f.invoiceId, list);
    }
  }

  // Approvals' answer, from the approval_plans / approval_steps tables (feature 6's real API).
  const store = new PostgresApprovalStore(db);
  const approvalFacts = new Map<string, ApprovalFacts>();
  for (const id of ids) {
    const plans = await getApprovalPlans(id, { store });
    if (plans.length === 0) continue;
    const current = await getCurrentApprovalPlan(id, { invoiceVersion: invoicesById.get(id)!.version, store });
    // Only a COMPLETED approval approves a payee and an amount: a routed plan whose every step is
    // approved. Pending, rejected, held or blocked plans approve nothing (TODO review finding, P1).
    const complete = current && current.outcome === "route" && current.steps.length > 0 && current.steps.every((s) => s.decision === "approved");
    approvalFacts.set(id, {
      approverIds: [...approversOf(...plans)],
      basis: complete ? { vendorId: current.basis.vendorId ?? "", currency: current.basis.currency as Currency, totalCents: current.basis.totalCents } : null,
    });
  }

  const latestPolicy = new Map<string, (typeof policyRows)[number]>();
  for (const r of policyRows) if (!latestPolicy.has(r.id)) latestPolicy.set(r.id, r);
  const policies = [...latestPolicy.values()].map((r) =>
    ApprovalPolicy.parse({ id: r.id, version: r.version, active: r.active, ruleType: r.ruleType, priority: r.priority, conditions: r.conditions, steps: r.steps, description: r.description }),
  );

  const audit: AuditEvent[] = opts.auditFor ? await loadAudit(db, opts.auditFor.invoiceId, invoicesById.get(opts.auditFor.invoiceId)?.vendorId) : [];

  return {
    users: usersById,
    vendors: vendorsById,
    invoices: invoicesById,
    policies,
    bankAccounts,
    payments: paymentRecs,
    flags: flagRecs,
    audit,
    invoiceFlags: openFlags,
    // Ids the service makes (PAY-…, FLG-…) start from the clock, so two actions never collide.
    seq: Date.now(),
    approvalFacts,
  };
}

const PAYMENT_ENTITY_TYPES = new Set(["payment", "payment_flag", "bank_account", "invoice"]);

/** The payments-side audit trail of one invoice, shaped like the service's own AuditEvent. */
async function loadAudit(db: Executor, invoiceId: string, vendorId: string | undefined): Promise<AuditEvent[]> {
  const rows = await db
    .select()
    .from(auditEvents)
    .where(
      vendorId
        ? or(eq(auditEvents.invoiceId, invoiceId), and(eq(auditEvents.entityType, "bank_account"), sql`${auditEvents.entityId} LIKE ${`${vendorId}#%`}`))
        : eq(auditEvents.invoiceId, invoiceId),
    )
    .orderBy(asc(auditEvents.occurredAt), asc(auditEvents.id));
  return rows
    .filter((r) => PAYMENT_ENTITY_TYPES.has(r.entityType) && (r.action.startsWith("payment") || r.action.startsWith("bank_account") || r.action === "invoice.status_changed"))
    .map((r) => {
      const event = (r.metadata as Record<string, unknown> | null)?.event;
      return {
        id: String(r.id),
        occurredAt: iso(r.occurredAt)!,
        actorId: r.actorId,
        onBehalfOf: r.onBehalfOf,
        // fire() records "invoice.status_changed" + metadata.event; payments names it invoice.<event>.
        action: r.action === "invoice.status_changed" && typeof event === "string" ? `invoice.${event}` : r.action,
        entityType: r.entityType as AuditEvent["entityType"],
        entityId: r.entityId,
        invoiceId: r.invoiceId,
        before: r.before,
        after: r.after,
        reason: r.reason,
      };
    });
}

// ---------------------------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------------------------

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const INVOICE_EVENTS = new Set<InvoiceEvent>(["schedule", "paymentSettled", "paymentFailed", "paymentCancelled"]);

function paymentValues(p: PaymentRec, bankId: number) {
  return {
    invoiceId: p.invoiceId,
    attemptNo: p.attemptNo,
    vendorId: p.vendorId,
    bankAccountId: bankId,
    method: p.method,
    scheduledDate: p.scheduledDate || null,
    paidDate: p.settledAt ? p.settledAt.slice(0, 10) : null,
    currency: p.currency,
    amountCents: p.amountCents,
    fxRate: p.fxRateToCad,
    amountCadCents: p.amountCadCents,
    reference: p.bankReference,
    status: p.status,
    preparedBy: p.preparedBy || null,
    releasedBy: p.releasedBy,
    releasedAt: p.releasedAt,
    settledAt: p.settledAt,
    failedAt: p.failedAt,
    failureCode: p.failure?.code ?? null,
    failure: p.failure,
    cancelledAt: p.cancelledAt,
    cancelledBy: p.cancelledBy,
    cancelReason: p.cancelReason,
    holdReason: p.holdReason,
  };
}

function flagValues(f: FlagRec) {
  return {
    urgency: f.urgency,
    reasonCode: f.reasonCode,
    message: f.message,
    scope: f.scope,
    vendorId: f.vendorId,
    paymentId: f.paymentId,
    createdAt: f.createdAt,
    clearedBy: f.clearedBy,
    clearedAt: f.clearedAt,
    clearNote: f.clearNote,
    clearedAutomatically: f.clearedAutomatically,
  };
}

/** Writes everything the action changed on `after` compared with `before`, in the action's transaction. */
async function saveChanges(ctx: ActionContext, before: PaymentsState, after: PaymentsState): Promise<void> {
  const { tx } = ctx;

  // 1. Bank accounts: new versions, then status changes — demotions (superseded / closed / rejected) before
  //    the promotion to verified, because the database allows one verified account per supplier.
  const bankKey = (a: Pick<BankAccountVersion, "vendorId" | "version">) => `${a.vendorId}#${a.version}`;
  const oldBanks = new Map(before.bankAccounts.map((a) => [bankKey(a), a]));
  const changedBanks = after.bankAccounts.filter((a) => oldBanks.has(bankKey(a)) && !same(oldBanks.get(bankKey(a)), a));
  changedBanks.sort((a, b) => Number(a.status === "verified") - Number(b.status === "verified"));
  for (const a of after.bankAccounts.filter((x) => !oldBanks.has(bankKey(x)))) {
    await tx.insert(vendorBankAccounts).values({
      vendorId: a.vendorId,
      version: a.version,
      status: a.status,
      currency: a.currency,
      institution: a.institution,
      transit: a.transit,
      account: a.account,
      last4: a.last4,
      changedAt: a.changedAt,
      channel: a.channel,
      requestedBy: a.requestedBy,
      verifiedBy: a.verifiedBy,
      verifiedAt: a.verifiedAt,
    });
  }
  for (const a of changedBanks) {
    await tx
      .update(vendorBankAccounts)
      .set({ status: a.status, verifiedBy: a.verifiedBy, verifiedAt: a.verifiedAt })
      .where(and(eq(vendorBankAccounts.vendorId, a.vendorId), eq(vendorBankAccounts.version, a.version)));
  }

  // 2. Payments (each points at the exact bank-account version it pays to).
  const bankIds = new Map((await tx.select({ id: vendorBankAccounts.id, vendorId: vendorBankAccounts.vendorId, version: vendorBankAccounts.version }).from(vendorBankAccounts)).map((b) => [`${b.vendorId}#${b.version}`, b.id]));
  const oldPayments = new Map(before.payments.map((p) => [p.paymentId, p]));
  for (const p of after.payments) {
    const old = oldPayments.get(p.paymentId);
    if (old && same(old, p)) continue;
    const bankId = bankIds.get(`${p.vendorId}#${p.bankVersion}`);
    if (bankId === undefined) throw new Error(`No bank account ${p.vendorId} version ${p.bankVersion} for payment ${p.paymentId}.`);
    if (!old) await tx.insert(payments).values({ id: p.paymentId, ...paymentValues(p, bankId) });
    else await tx.update(payments).set(paymentValues(p, bankId)).where(eq(payments.id, p.paymentId));
  }

  // 3. Urgency flags.
  const oldFlags = new Map(before.flags.map((f) => [f.flagId, f]));
  for (const f of after.flags) {
    const old = oldFlags.get(f.flagId);
    if (old && same(old, f)) continue;
    if (!old) await tx.insert(paymentFlags).values({ id: f.flagId, ...flagValues(f) });
    else await tx.update(paymentFlags).set(flagValues(f)).where(eq(paymentFlags.id, f.flagId));
  }

  // 4. What the action recorded, in order: invoice events go through fire() (the state machine and its
  //    own audit row); everything else becomes an audit_events row in this same transaction.
  for (const e of after.audit.slice(before.audit.length)) {
    if (e.action.startsWith("invoice.")) {
      const event = e.action.slice("invoice.".length) as InvoiceEvent;
      if (!INVOICE_EVENTS.has(event) || !e.invoiceId) throw new Error(`Payments raised an unknown invoice event ${e.action}.`);
      await fire(ctx, e.invoiceId, event, event === "paymentSettled" ? { fullyPaid: true } : {});
      continue;
    }
    const snapshot = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : v === null || v === undefined ? null : { value: v });
    await ctx.audit({
      action: e.action as AuditEventInput["action"],
      entityType: e.entityType,
      entityId: e.entityId,
      invoiceId: e.invoiceId,
      paymentId: e.entityType === "payment" ? e.entityId : null,
      before: snapshot(e.before),
      after: snapshot(e.after),
      reason: e.reason?.trim() ? e.reason : null,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Running the service on a loaded state
// ---------------------------------------------------------------------------------------------

async function read<T>(fn: () => T | Promise<T>, opts: Opts & { auditFor?: { invoiceId: string } } = {}): Promise<T> {
  const state = await loadPaymentsState(opts.db ?? getDb(), { auditFor: opts.auditFor });
  return runWithState(state, async () => fn());
}

type Refusal = Extract<ActionResult<never>, { ok: false }>;

async function act<T>(actor: Actor, fn: () => Promise<ActionResult<T>>, opts: Opts & { guard?: () => Promise<Refusal | null> } = {}): Promise<ActionResult<T>> {
  try {
    return await withAction(
      actor,
      async (ctx) => {
        const state = await loadPaymentsState(ctx.tx);
        const before = structuredClone(state);
        return runWithState(state, async () => {
          const refused = opts.guard ? await opts.guard() : null;
          if (refused) return refused;
          const result = await fn();
          if (result.ok) await saveChanges(ctx, before, state);
          return result;
        });
      },
      { db: opts.db ?? getDb() },
    );
  } catch (err) {
    // The invoice moved on in the meantime (or the database refused): nothing was written.
    if (err instanceof TransitionError) return { ok: false, status: 409, reasons: [{ code: "CONFLICT", message: err.message }] };
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// The brief's release rule for the Admin (Controller)
// ---------------------------------------------------------------------------------------------

/**
 * approval_policies P09–P11, as the brief points to: the Finance Manager releases up to $100,000 CAD,
 * the Controller over $100,000 CAD, and nobody releases what they approved. On this dashboard the
 * Admin (controller_admin) has no Payments area: they release ONLY a payment the Finance Manager
 * cannot (over $100k, or one the Finance Manager approved, scheduled or requested), and do not
 * schedule or cancel payments (AP Clerks prepare; P09 note).
 */
async function adminReleaseGuard(actorId: string, paymentId: string): Promise<Refusal | null> {
  const users = listUsers();
  const me = users.find((u) => u.id === actorId);
  if (me?.role !== "controller_admin") return null;
  const view = await listPayments(actorId);
  const row = view.payments.find((p) => p.attempts.some((a) => a.paymentId === paymentId));
  if (!row) return null; // the service answers "not found" itself
  const releasers = await eligibleReleasers(row.invoice.invoiceId);
  const fm = releasers.filter((p) => users.find((u) => u.id === p.userId)?.role === "finance_manager");
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
  if (listUsers().find((u) => u.id === actorId)?.role !== "controller_admin") return null;
  return { ok: false, status: 403, reasons: [{ code: "ADMIN_NO_PAYMENTS", message: `The Admin doesn't ${what}: AP Clerks prepare payments and the Finance Manager releases them. The Admin only releases what the Finance Manager can't.` }] };
}

// ---------------------------------------------------------------------------------------------
// The API the dashboard calls (same names as the service, on the database)
// ---------------------------------------------------------------------------------------------

export const paymentsDb = {
  list: (viewerId: string | null, opts: Opts = {}): Promise<PaymentsView> => read(() => listPayments(viewerId), opts),
  detail: (viewerId: string | null, invoiceId: string, opts: Opts = {}): Promise<PaymentRow | null> => read(() => getPaymentDetail(viewerId, invoiceId), opts),
  audit: (viewerId: string | null, invoiceId: string, opts: Opts = {}): Promise<AuditEvent[]> =>
    read(() => getPaymentAudit(viewerId, invoiceId), { ...opts, auditFor: { invoiceId } }),
  /** Who may release each invoice's current payment — with the Admin listed only when no Finance Manager can (adminReleaseGuard). */
  eligibleReleasers: (invoiceIds: string[], opts: Opts = {}): Promise<Person[][]> =>
    read(async () => {
      const roleOf = new Map(listUsers().map((u) => [u.id, u.role]));
      const lists = await Promise.all(invoiceIds.map((id) => eligibleReleasers(id)));
      return lists.map((people) => (people.some((p) => roleOf.get(p.userId) === "finance_manager") ? people.filter((p) => roleOf.get(p.userId) !== "controller_admin") : people));
    }, opts),
  supplierBank: (viewerId: string | null, vendorId: string, opts: Opts = {}) => read(() => getSupplierBank(viewerId, vendorId), opts),
  canClearFlags: (viewerId: string | null, flagIds: string[], opts: Opts = {}): Promise<Record<string, boolean>> =>
    read(() => Object.fromEntries(flagIds.map((id) => [id, canClearFlag(viewerId, id)])), opts),

  schedule: (actor: Actor, input: { invoiceId: string; payDate?: string }, opts: Opts = {}): Promise<ActionResult<PaymentRecord>> =>
    act(actor, () => schedulePayment(actor.userId, input), { ...opts, guard: () => adminCannot(actor.userId, "schedule payments") }),
  release: (actor: Actor, input: { paymentId: string }, opts: Opts = {}): Promise<ActionResult<PaymentRecord>> =>
    act(actor, () => releasePayment(actor.userId, input), { ...opts, guard: () => adminReleaseGuard(actor.userId, input.paymentId) }),
  cancel: (actor: Actor, input: { paymentId: string; reason: string }, opts: Opts = {}): Promise<ActionResult<PaymentRecord>> =>
    act(actor, () => cancelPayment(actor.userId, input), { ...opts, guard: () => adminCannot(actor.userId, "cancel payments") }),
  settle: (actor: Actor, input: { paymentId: string; outcome: "SETTLED" | FailureCode }, opts: Opts = {}): Promise<ActionResult<PaymentRecord>> =>
    act(actor, () => simulateSettlement(actor.userId, input), opts),
  clearFlag: (actor: Actor, input: { flagId: string; note: string }, opts: Opts = {}): Promise<ActionResult<PaymentFlag>> => act(actor, () => clearFlag(actor.userId, input), opts),
  requestBankChange: (actor: Actor, input: { vendorId: string; institution: string; transit: string; account: string }, opts: Opts = {}) =>
    act(actor, () => requestBankChange(actor.userId, input), opts),
  verifyBankChange: (actor: Actor, input: { vendorId: string }, opts: Opts = {}) => act(actor, () => verifyBankChange(actor.userId, input), opts),
  rejectBankChange: (actor: Actor, input: { vendorId: string; reason: string }, opts: Opts = {}) => act(actor, () => rejectBankChange(actor.userId, input), opts),
};

/** Payments that failed and still have open urgency flags, per supplier (for the vendor screen). */
export async function openPaymentFlagsByVendor(opts: Opts = {}): Promise<Map<string, number>> {
  const db = opts.db ?? getDb();
  const rows = await db
    .select({ vendorId: paymentFlags.vendorId, n: sql<number>`count(*)::int` })
    .from(paymentFlags)
    .where(isNull(paymentFlags.clearedAt))
    .groupBy(paymentFlags.vendorId);
  return new Map(rows.map((r) => [r.vendorId, Number(r.n)]));
}
