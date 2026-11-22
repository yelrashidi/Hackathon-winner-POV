/**
 * Everything payments reads from and writes to the database, all in this file. Other features'
 * data comes through their exported code (approvals' store); payments' own tables (payments,
 * payment_flags) and the bank-account versions (R5: payments holds the minimum bank-change data
 * until vendors exists) are queried here. Status changes go through fire() and audit rows through
 * withAction() in service.ts, never from here.
 *
 * Every function takes the executor: the database, or the action's transaction. Inside withAction
 * every query must use the transaction (BUG-Andrew-04).
 * What each assumes, and whose it is: docs/payment-assumptions.md.
 */

import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { ApprovalPolicy } from "@/contracts/approvals";
import type { Flag } from "@/contracts/flag";
import { FAILURE_REASONS, type Currency, type FailureCode, type FlagScope, type FlagUrgency, type PaymentFailure, type PaymentMethod, type PaymentStatus } from "@/contracts/payment";
import type { Executor, Tx } from "@/server/db/client";
import { approvalPolicies, auditEvents, invoiceFlags, invoices, paymentFlags, payments, users, vendorBankAccounts, vendors } from "@/server/db/schema";
import { approversOf, getApprovalPlans, getCurrentApprovalPlan, type DirectoryUser, type UserRole } from "@/server/features/approvals";
import { PostgresApprovalStore } from "@/server/pipeline";
import { dueDateFor } from "./rules";
import type { ApprovalFacts, AuditEvent, BankAccountVersion, FlagRec, InvoiceRec, PaymentRec, PaymentsData, VendorRec } from "./types";

const iso = (v: string | null) => (v === null ? null : new Date(v).toISOString());

// ---------------------------------------------------------------------------------------------
// People, suppliers, release policies
// ---------------------------------------------------------------------------------------------

function toUser(u: typeof users.$inferSelect): DirectoryUser {
  return {
    id: u.id,
    fullName: u.fullName,
    role: u.role as UserRole,
    departmentId: u.departmentId ?? "",
    managerId: u.managerId,
    approvalLimitCents: u.approvalLimitCents,
    status: u.status,
    statusSince: u.statusSince,
    delegateId: u.delegateId,
  };
}

/** Everyone in the users table except the `system` user. */
export async function loadUsers(exec: Executor): Promise<Map<string, DirectoryUser>> {
  const rows = await exec.select().from(users).where(ne(users.role, "system"));
  return new Map(rows.map((u) => [u.id, toUser(u)]));
}

export async function getUser(exec: Executor, userId: string): Promise<DirectoryUser | undefined> {
  const [u] = await exec.select().from(users).where(and(eq(users.id, userId), ne(users.role, "system")));
  return u ? toUser(u) : undefined;
}

export async function getVendor(exec: Executor, vendorId: string): Promise<VendorRec | undefined> {
  const [v] = await exec.select({ id: vendors.id, legalName: vendors.legalName, status: vendors.status, paymentTermsDays: vendors.paymentTermsDays }).from(vendors).where(eq(vendors.id, vendorId));
  return v;
}

/** The latest version of each active payment_release policy (P09 / P10). */
async function loadReleasePolicies(exec: Executor): Promise<ApprovalPolicy[]> {
  const rows = await exec.select().from(approvalPolicies).where(eq(approvalPolicies.ruleType, "payment_release")).orderBy(asc(approvalPolicies.id), desc(approvalPolicies.version));
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!latest.has(r.id)) latest.set(r.id, r);
  return [...latest.values()]
    .map((r) => ApprovalPolicy.parse({ id: r.id, version: r.version, active: r.active, ruleType: r.ruleType, priority: r.priority, conditions: r.conditions, steps: r.steps, description: r.description }))
    .filter((p) => p.active);
}

// ---------------------------------------------------------------------------------------------
// Invoices in view (decided 2026-11-21: open work, plus anything paid through the app)
// ---------------------------------------------------------------------------------------------

const PAYABLE_STATUSES = ["Approved", "PaymentScheduled", "Paid"];

/**
 * Approved or scheduled invoices, and paid ones whose settlement the app wrote (the seed marks its
 * rebuilt events metadata.imported, so the dataset's own paid history stays out). EFT only for
 * now: an invoice with a cheque or card payment is left out.
 */
function inView() {
  return and(
    inArray(invoices.status, PAYABLE_STATUSES),
    or(
      ne(invoices.status, "Paid"),
      sql`EXISTS (SELECT 1 FROM audit_events e WHERE e.invoice_id = ${invoices.id} AND e.action = 'payment.settled' AND coalesce(e.metadata->>'imported', 'false') <> 'true')`,
    ),
    sql`NOT EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = ${invoices.id} AND p.method <> 'EFT')`,
  );
}

export interface Scope {
  invoiceId?: string;
  vendorId?: string;
  /** Harborline's calendar day: the due date of an invoice without one. */
  today: string;
}

export async function loadInvoices(exec: Executor, scope: Scope): Promise<InvoiceRec[]> {
  const rows = await exec
    .select({ inv: invoices, termsDays: vendors.paymentTermsDays })
    .from(invoices)
    .leftJoin(vendors, eq(vendors.id, invoices.vendorId))
    .where(and(inView(), scope.invoiceId ? eq(invoices.id, scope.invoiceId) : undefined, scope.vendorId ? eq(invoices.vendorId, scope.vendorId) : undefined))
    .orderBy(asc(invoices.id));
  return rows.map(({ inv: r, termsDays }) => {
    const totalCents = r.totalCents ?? 0;
    return {
      id: r.id,
      version: r.version,
      status: r.status,
      vendorId: r.vendorId ?? "",
      vendorInvoiceNumber: r.invoiceNumber ?? "",
      invoiceDate: r.invoiceDate ?? "",
      dueDate: dueDateFor(r.dueDate, r.invoiceDate, termsDays, scope.today),
      currency: (r.currency ?? "") as Currency,
      totalCents,
      totalCadCents: r.totalCadCents ?? 0,
      // A CAD invoice may have no stored rate; approvals reads it the same way.
      fxRate: r.fxRate ?? "1",
      departmentId: r.departmentId ?? "",
      requesterId: r.requesterId ?? "",
      isCreditNote: r.isCreditNote || totalCents < 0,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Payments' own data
// ---------------------------------------------------------------------------------------------

/** Every attempt of these invoices, with the bank-account version each one pays. */
async function loadAttempts(exec: Executor, invoiceIds: string[]): Promise<PaymentRec[]> {
  if (invoiceIds.length === 0) return [];
  const rows = await exec
    .select({ p: payments, bankVersion: vendorBankAccounts.version, bankLast4: vendorBankAccounts.last4 })
    .from(payments)
    .leftJoin(vendorBankAccounts, eq(vendorBankAccounts.id, payments.bankAccountId))
    .where(inArray(payments.invoiceId, invoiceIds))
    .orderBy(asc(payments.invoiceId), asc(payments.attemptNo));
  const out: PaymentRec[] = [];
  for (const { p, bankVersion, bankLast4 } of rows) {
    // An EFT attempt always pays one bank-account version; one without (no account on file) can't be shown.
    if (bankVersion === null || bankLast4 === null) continue;
    out.push({
      paymentId: p.id,
      invoiceId: p.invoiceId,
      vendorId: p.vendorId ?? "",
      attemptNo: p.attemptNo,
      status: p.status as PaymentStatus,
      method: p.method as PaymentMethod,
      currency: p.currency as Currency,
      amountCents: p.amountCents,
      amountCadCents: p.amountCadCents,
      fxRateToCad: p.fxRate ?? "1",
      scheduledDate: p.scheduledDate ?? "",
      bankVersion,
      bankLast4,
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
    });
  }
  return out;
}

function toFlagRec(f: typeof paymentFlags.$inferSelect, invoiceId: string): FlagRec {
  return {
    flagId: f.id,
    urgency: f.urgency as FlagUrgency,
    reasonCode: f.reasonCode as FailureCode,
    message: f.message,
    scope: f.scope as FlagScope,
    vendorId: f.vendorId,
    invoiceId,
    paymentId: f.paymentId,
    createdAt: iso(f.createdAt)!,
    clearedBy: f.clearedBy,
    clearedAt: iso(f.clearedAt),
    clearNote: f.clearNote,
    clearedAutomatically: f.clearedAutomatically,
  };
}

/** Every payment flag on these suppliers, open and cleared, oldest first. */
export async function loadFlags(exec: Executor, vendorIds: string[]): Promise<FlagRec[]> {
  if (vendorIds.length === 0) return [];
  const rows = await exec
    .select({ f: paymentFlags, invoiceId: payments.invoiceId })
    .from(paymentFlags)
    .innerJoin(payments, eq(payments.id, paymentFlags.paymentId))
    .where(inArray(paymentFlags.vendorId, vendorIds))
    .orderBy(asc(paymentFlags.createdAt), asc(paymentFlags.id));
  return rows.map(({ f, invoiceId }) => toFlagRec(f, invoiceId));
}

/** Every bank-account version of these suppliers, oldest first. */
export async function loadBankAccounts(exec: Executor, vendorIds: string[]): Promise<BankAccountVersion[]> {
  if (vendorIds.length === 0) return [];
  const rows = await exec.select().from(vendorBankAccounts).where(inArray(vendorBankAccounts.vendorId, vendorIds)).orderBy(asc(vendorBankAccounts.vendorId), asc(vendorBankAccounts.version));

  // Why a closed account was closed: the flag its failed payment raised (decided 2026-11-21, no new column).
  const closedIds = rows.filter((r) => r.status === "closed").map((r) => r.id);
  const closedReason = new Map<number, FailureCode>();
  if (closedIds.length) {
    const raised = await exec
      .select({ accountId: payments.bankAccountId, code: paymentFlags.reasonCode })
      .from(paymentFlags)
      .innerJoin(payments, eq(payments.id, paymentFlags.paymentId))
      .where(inArray(payments.bankAccountId, closedIds))
      .orderBy(desc(paymentFlags.createdAt));
    for (const r of raised) {
      const code = r.code as FailureCode;
      if (r.accountId !== null && !closedReason.has(r.accountId) && FAILURE_REASONS[code]?.retryRule === "FIX_BANK_DETAILS") closedReason.set(r.accountId, code);
    }
  }

  return rows.map((r) => ({
    accountId: r.id,
    vendorId: r.vendorId,
    version: r.version,
    status: r.status as BankAccountVersion["status"],
    institution: r.institution,
    transit: r.transit,
    account: r.account,
    last4: r.last4,
    currency: r.currency as Currency,
    changedAt: r.changedAt,
    channel: r.channel,
    requestedBy: r.requestedBy,
    verifiedBy: r.verifiedBy,
    verifiedAt: iso(r.verifiedAt),
    closedReason: closedReason.get(r.id) ?? null,
  }));
}

/** Open validation / duplicate flags per invoice. TEMP: validation exports no reader for stored flags yet. */
async function loadOpenInvoiceFlags(exec: Executor, invoiceIds: string[]): Promise<Map<string, Flag[]>> {
  const out = new Map<string, Flag[]>();
  if (invoiceIds.length === 0) return out;
  const rows = await exec.select().from(invoiceFlags).where(and(inArray(invoiceFlags.invoiceId, invoiceIds), eq(invoiceFlags.status, "open"))).orderBy(asc(invoiceFlags.id));
  for (const f of rows) {
    const list = out.get(f.invoiceId) ?? [];
    list.push({
      code: f.code,
      severity: f.severity as Flag["severity"],
      message: f.message,
      evidence: (f.evidence ?? {}) as Record<string, unknown>,
      status: f.status as Flag["status"],
      resolvedBy: f.resolvedBy,
      resolutionNote: f.resolutionNote,
    });
    out.set(f.invoiceId, list);
  }
  return out;
}

// Approvals (Youssef) — A1, A3b: his store on the database (the seed loads the dataset's history into it).
async function getApprovalFacts(exec: Executor, invoice: InvoiceRec): Promise<ApprovalFacts | undefined> {
  const store = new PostgresApprovalStore(exec);
  const plans = await getApprovalPlans(invoice.id, { store });
  if (plans.length === 0) return undefined;
  const current = await getCurrentApprovalPlan(invoice.id, { store, invoiceVersion: invoice.version });
  if (!current) return { approverIds: [...approversOf(...plans)], basis: null };
  return {
    approverIds: [...approversOf(...plans)],
    basis: {
      // A plan with no vendor (unmatched invoice) approves no payee: PAYEE_MISMATCH.
      vendorId: current.basis.vendorId ?? "",
      currency: current.basis.currency as Currency,
      totalCents: current.basis.totalCents,
    },
  };
}

/** Everything the rules look at for the invoices in view (one invoice, one supplier's, or all). */
export async function loadData(exec: Executor, scope: Scope): Promise<PaymentsData> {
  const invoiceList = await loadInvoices(exec, scope);
  const invoiceIds = invoiceList.map((i) => i.id);
  const vendorIds = [...new Set([...invoiceList.map((i) => i.vendorId), ...(scope.vendorId ? [scope.vendorId] : [])].filter(Boolean))];
  const [userMap, vendorRows, policies, attempts, bankAccounts, flags, invoiceFlagMap] = await Promise.all([
    loadUsers(exec),
    vendorIds.length
      ? exec.select({ id: vendors.id, legalName: vendors.legalName, status: vendors.status, paymentTermsDays: vendors.paymentTermsDays }).from(vendors).where(inArray(vendors.id, vendorIds))
      : Promise.resolve([]),
    loadReleasePolicies(exec),
    loadAttempts(exec, invoiceIds),
    loadBankAccounts(exec, vendorIds),
    loadFlags(exec, vendorIds),
    loadOpenInvoiceFlags(exec, invoiceIds),
  ]);
  const approvals = new Map<string, ApprovalFacts | undefined>();
  for (const invoice of invoiceList) approvals.set(invoice.id, await getApprovalFacts(exec, invoice));
  return {
    users: userMap,
    vendors: new Map(vendorRows.map((v) => [v.id, v])),
    policies,
    invoices: invoiceList,
    attempts,
    bankAccounts,
    flags,
    invoiceFlags: invoiceFlagMap,
    approvals,
  };
}

// ---------------------------------------------------------------------------------------------
// Finding (and locking) the row an action is about
// ---------------------------------------------------------------------------------------------

export async function findPayment(exec: Executor, paymentId: string, lock: boolean): Promise<{ paymentId: string; invoiceId: string } | undefined> {
  const q = exec.select({ paymentId: payments.id, invoiceId: payments.invoiceId }).from(payments).where(eq(payments.id, paymentId));
  const [row] = lock ? await q.for("update") : await q;
  return row;
}

/** A flag, and who scheduled the payment that raised it. */
export async function findFlag(exec: Executor, flagId: string, lock: boolean): Promise<{ flag: FlagRec; scheduledBy: string | null } | undefined> {
  const q = exec
    .select({ f: paymentFlags, invoiceId: payments.invoiceId, preparedBy: payments.preparedBy })
    .from(paymentFlags)
    .innerJoin(payments, eq(payments.id, paymentFlags.paymentId))
    .where(eq(paymentFlags.id, flagId));
  const [row] = lock ? await q.for("update", { of: paymentFlags }) : await q;
  return row ? { flag: toFlagRec(row.f, row.invoiceId), scheduledBy: row.preparedBy } : undefined;
}

export async function lockInvoice(exec: Executor, invoiceId: string): Promise<void> {
  await exec.select({ id: invoices.id }).from(invoices).where(eq(invoices.id, invoiceId)).for("update");
}

/** Bank changes to one supplier happen one at a time. */
export async function lockVendor(exec: Executor, vendorId: string): Promise<void> {
  await exec.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, vendorId)).for("update");
}

// ---------------------------------------------------------------------------------------------
// Audit trail (read side; rows are written only through withAction)
// ---------------------------------------------------------------------------------------------

/** The invoice-status events payments fires. */
const PAYMENT_EVENTS = ["schedule", "paymentSettled", "paymentFailed", "paymentCancelled"];

/**
 * The invoice's payment events, oldest first (decided 2026-11-21): payments, payment flags, the
 * supplier's bank accounts and the invoice's payment status changes, including the seed's rebuilt
 * history. A fire() status change is shown as `invoice.<event>`, the name the dashboard knows.
 */
export async function loadPaymentAudit(exec: Executor, invoiceId: string, vendorId: string): Promise<AuditEvent[]> {
  const rows = await exec
    .select()
    .from(auditEvents)
    .where(
      or(
        and(
          eq(auditEvents.invoiceId, invoiceId),
          or(
            inArray(auditEvents.entityType, ["payment", "payment_flag"]),
            and(eq(auditEvents.action, "invoice.status_changed"), inArray(sql`${auditEvents.metadata}->>'event'`, PAYMENT_EVENTS)),
          ),
        ),
        and(eq(auditEvents.entityType, "bank_account"), sql`starts_with(${auditEvents.entityId}, ${`${vendorId}#`})`),
      ),
    )
    .orderBy(asc(auditEvents.occurredAt), asc(auditEvents.id));
  return rows.map((e) => ({
    id: String(e.id),
    occurredAt: iso(e.occurredAt)!,
    actorId: e.actorId,
    onBehalfOf: e.onBehalfOf,
    action: e.action === "invoice.status_changed" ? `invoice.${(e.metadata as { event?: string }).event}` : e.action,
    entityType: e.entityType as AuditEvent["entityType"],
    entityId: e.entityId,
    invoiceId: e.invoiceId,
    before: e.before,
    after: e.after,
    reason: e.reason,
  }));
}

// ---------------------------------------------------------------------------------------------
// Writes (inside the action's transaction)
// ---------------------------------------------------------------------------------------------

/** New payment ids continue the dataset's numbering: PAY-00416, PAY-00417, … (decided 2026-11-21). */
export async function nextPaymentId(tx: Tx): Promise<string> {
  const [row] = await tx.select({ n: sql<string | null>`max(substring(${payments.id} from '^PAY-([0-9]+)$')::int)::text` }).from(payments);
  return `PAY-${String(Number(row?.n ?? 0) + 1).padStart(5, "0")}`;
}

export async function insertPayment(tx: Tx, row: typeof payments.$inferInsert): Promise<void> {
  await tx.insert(payments).values(row);
}

export async function updatePayment(tx: Tx, paymentId: string, patch: Partial<typeof payments.$inferInsert>): Promise<void> {
  await tx.update(payments).set(patch).where(eq(payments.id, paymentId));
}

/** Critical: every scheduled payment to the supplier goes on hold. Returns the ones it stopped. */
export async function holdScheduledPayments(tx: Tx, vendorId: string, holdReason: string): Promise<{ paymentId: string; invoiceId: string }[]> {
  return tx
    .update(payments)
    .set({ status: "on_hold", holdReason })
    .where(and(eq(payments.vendorId, vendorId), eq(payments.status, "scheduled")))
    .returning({ paymentId: payments.id, invoiceId: payments.invoiceId });
}

/** The fraud hold is cleared: held payments go back to scheduled. Returns the ones it released. */
export async function releaseHolds(tx: Tx, vendorId: string): Promise<{ paymentId: string; invoiceId: string }[]> {
  return tx
    .update(payments)
    .set({ status: "scheduled", holdReason: null })
    .where(and(eq(payments.vendorId, vendorId), eq(payments.status, "on_hold")))
    .returning({ paymentId: payments.id, invoiceId: payments.invoiceId });
}

export async function insertFlag(tx: Tx, row: typeof paymentFlags.$inferInsert): Promise<string> {
  const [created] = await tx.insert(paymentFlags).values(row).returning({ id: paymentFlags.id });
  return created!.id;
}

export async function updateFlag(tx: Tx, flagId: string, patch: Partial<typeof paymentFlags.$inferInsert>): Promise<void> {
  await tx.update(paymentFlags).set(patch).where(eq(paymentFlags.id, flagId));
}

export async function hasOpenCriticalFlag(tx: Tx, vendorId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: paymentFlags.id })
    .from(paymentFlags)
    .where(and(eq(paymentFlags.vendorId, vendorId), eq(paymentFlags.urgency, "critical"), eq(paymentFlags.scope, "supplier"), isNull(paymentFlags.clearedAt)));
  return rows.length > 0;
}

export async function insertBankAccount(tx: Tx, row: typeof vendorBankAccounts.$inferInsert): Promise<void> {
  await tx.insert(vendorBankAccounts).values(row);
}

export async function updateBankAccount(tx: Tx, accountId: number, patch: Partial<typeof vendorBankAccounts.$inferInsert>): Promise<void> {
  await tx.update(vendorBankAccounts).set(patch).where(eq(vendorBankAccounts.id, accountId));
}
