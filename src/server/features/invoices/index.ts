import { and, eq, inArray, sql } from "drizzle-orm";
import type { Actor } from "@/contracts/actor";
import type { AuditInvoiceDetail, AuditInvoiceList, AuditInvoiceListQuery } from "@/contracts/audit-view";
import { recordDenied } from "@/server/core/audit";
import { authorize, Forbidden } from "@/server/core/authorize";
import { getDb, type Db } from "@/server/db/client";
import { approvalSteps, invoices, users } from "@/server/db/schema";
import { loadInvoiceDetail } from "@/server/features/audit/detail";
import { queryInvoiceList } from "@/server/features/audit/list";
import { whoDidWhat, type ChainStep } from "@/server/features/audit/who-did-what";

/**
 * Invoice records — read-only, for everyone who works with invoices, scoped exactly as the roles
 * matrix's "View invoices" row says (docs/architecture/roles-and-permissions.md):
 *
 *   Employee     own submissions          (invoices they requested)
 *   Approver     own department
 *   AP Clerk, Finance Manager, Controller, Auditor   all invoices
 *
 *   listInvoiceRecords(actor, query)    the invoices this person may see, history included, each with
 *                                       where it is in plain words (the employee's "My bills")
 *   getInvoiceRecord(actor, invoiceId)  one invoice: header, document, coding, flags, approvals,
 *                                       payments and the who-did-what chain (feature 6: "invoice,
 *                                       coding and approval history on one screen")
 *
 * NOT here: the full audit log (every event with before / after, control checks, export). That is
 * features/audit, for the Auditor and the Controller only.
 */

/** Which invoices a person may see. */
export type InvoiceScope = { kind: "all" } | { kind: "department"; departmentId: string } | { kind: "own"; userId: string };

/** What a record screen shows: the audit detail without the audit log itself, plus the chain and where it is in plain words. */
export type InvoiceRecord = Omit<AuditInvoiceDetail, "timeline" | "controls" | "validationRuns" | "extraction"> & { chain: ChainStep[]; where: string };

export async function invoiceScope(actor: Actor, opts: { db?: Db } = {}): Promise<InvoiceScope> {
  const db = opts.db ?? getDb();
  let who;
  try {
    who = authorize(actor, "invoice.view").actor;
  } catch (err) {
    if (err instanceof Forbidden) await recordDenied(actor, { attempted: "invoice.view", reason: err.reason }, { db });
    throw err;
  }
  if (who.role === "employee") return { kind: "own", userId: who.userId };
  if (who.role === "approver") {
    const [u] = await db.select({ departmentId: users.departmentId }).from(users).where(eq(users.id, who.userId));
    // A manager with no department on record sees only what they requested themselves.
    return u?.departmentId ? { kind: "department", departmentId: u.departmentId } : { kind: "own", userId: who.userId };
  }
  return { kind: "all" };
}

export function inScope(scope: InvoiceScope, inv: { departmentId: string | null; requesterId: string | null }): boolean {
  if (scope.kind === "all") return true;
  if (scope.kind === "department") return inv.departmentId === scope.departmentId;
  return inv.requesterId === scope.userId;
}

export async function listInvoiceRecords(
  actor: Actor,
  query: AuditInvoiceListQuery = {},
  opts: { db?: Db } = {},
): Promise<AuditInvoiceList & { scope: InvoiceScope; where: Record<string, string> }> {
  const db = opts.db ?? getDb();
  const scope = await invoiceScope(actor, { db });
  const list = await queryInvoiceList(db, query, scope.kind === "department" ? { departmentId: scope.departmentId } : scope.kind === "own" ? { requesterId: scope.userId } : {});
  return { ...list, scope, where: await whereItIs(db, list.rows) };
}

/**
 * Where a bill is, in the words an employee uses: in checks · waiting for <approver> · approved ·
 * scheduled · paid · rejected. "Waiting for" names the person the current approval step is assigned
 * to (a delegate when the approver is on leave).
 */
export function plainStatus(status: string, waitingFor: string | null): string {
  switch (status) {
    case "ManualEntry":
    case "InReview":
    case "OnHold":
      return "in checks";
    case "PendingApproval":
      return waitingFor ? `waiting for ${waitingFor}` : "waiting for approval";
    case "Approved":
      return "approved";
    case "PaymentScheduled":
      return "scheduled";
    case "Paid":
    case "Closed":
      return "paid";
    case "Voided":
      return "rejected";
    default:
      return status;
  }
}

async function whereItIs(db: Db, rows: { invoiceId: string; status: string }[]): Promise<Record<string, string>> {
  const pending = rows.filter((r) => r.status === "PendingApproval").map((r) => r.invoiceId);
  const waiting = new Map<string, string>();
  if (pending.length > 0) {
    // The lowest pending step of each invoice's latest approval plan.
    const steps = await db
      .select({ invoiceId: approvalSteps.invoiceId, seq: approvalSteps.seq, name: users.fullName })
      .from(approvalSteps)
      .leftJoin(users, eq(users.id, sql`coalesce(${approvalSteps.assignedTo}, ${approvalSteps.routedTo})`))
      .where(
        and(
          inArray(approvalSteps.invoiceId, pending),
          eq(approvalSteps.decision, "pending"),
          sql`${approvalSteps.planId} = (SELECT p.id FROM approval_plans p WHERE p.invoice_id = ${approvalSteps.invoiceId} ORDER BY p.routed_at DESC, p.attempt DESC LIMIT 1)`,
        ),
      )
      .orderBy(approvalSteps.invoiceId, approvalSteps.seq);
    for (const s of steps) if (!waiting.has(s.invoiceId) && s.name) waiting.set(s.invoiceId, s.name);
  }
  return Object.fromEntries(rows.map((r) => [r.invoiceId, plainStatus(r.status, waiting.get(r.invoiceId) ?? null)]));
}

/** Null when the invoice does not exist. Out of the person's scope → Forbidden (and the attempt is logged). */
export async function getInvoiceRecord(actor: Actor, invoiceId: string, opts: { db?: Db; stepLabel?: (role: string) => string } = {}): Promise<InvoiceRecord | null> {
  const db = opts.db ?? getDb();
  const scope = await invoiceScope(actor, { db });
  const [inv] = await db.select({ departmentId: invoices.departmentId, requesterId: invoices.requesterId }).from(invoices).where(eq(invoices.id, invoiceId));
  if (!inv) return null;
  if (!inScope(scope, inv)) {
    const reason = scope.kind === "department" ? "This invoice belongs to another department." : "You can only see invoices you requested.";
    await recordDenied(actor, { attempted: "invoice.view", reason, invoiceId }, { db });
    throw new Forbidden("invoice.view", reason);
  }
  const d = await loadInvoiceDetail(db, invoiceId);
  // The record view leaves out the audit log itself (events, controls, validation runs, raw extraction).
  const record: Omit<InvoiceRecord, "chain" | "where"> = { invoice: d.invoice, document: d.document, lines: d.lines, taxes: d.taxes, flags: d.flags, approvals: d.approvals, payments: d.payments, paymentFlags: d.paymentFlags };
  const where = (await whereItIs(db, [{ invoiceId, status: d.invoice.status }]))[invoiceId]!;
  return { ...record, chain: whoDidWhat(d, opts.stepLabel ? { stepLabel: opts.stepLabel } : {}), where };
}
