import { eq } from "drizzle-orm";
import type { Actor } from "@/contracts/actor";
import type { AuditInvoiceDetail, AuditInvoiceList, AuditInvoiceListQuery } from "@/contracts/audit-view";
import { recordDenied } from "@/server/core/audit";
import { authorize, Forbidden } from "@/server/core/authorize";
import { getDb, type Db } from "@/server/db/client";
import { invoices, users } from "@/server/db/schema";
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
 *   listInvoiceRecords(actor, query)    the invoices this person may see, history included
 *   getInvoiceRecord(actor, invoiceId)  one invoice: header, document, coding, flags, approvals,
 *                                       payments and the who-did-what chain (feature 6: "invoice,
 *                                       coding and approval history on one screen")
 *
 * NOT here: the full audit log (every event with before / after, control checks, export). That is
 * features/audit, for the Auditor and the Controller only.
 */

/** Which invoices a person may see. */
export type InvoiceScope = { kind: "all" } | { kind: "department"; departmentId: string } | { kind: "own"; userId: string };

/** What a record screen shows: the audit detail without the audit log itself, plus the chain. */
export type InvoiceRecord = Omit<AuditInvoiceDetail, "timeline" | "controls" | "validationRuns" | "extraction"> & { chain: ChainStep[] };

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

export async function listInvoiceRecords(actor: Actor, query: AuditInvoiceListQuery = {}, opts: { db?: Db } = {}): Promise<AuditInvoiceList & { scope: InvoiceScope }> {
  const db = opts.db ?? getDb();
  const scope = await invoiceScope(actor, { db });
  const list = await queryInvoiceList(db, query, scope.kind === "department" ? { departmentId: scope.departmentId } : scope.kind === "own" ? { requesterId: scope.userId } : {});
  return { ...list, scope };
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
  const record: Omit<InvoiceRecord, "chain"> = { invoice: d.invoice, document: d.document, lines: d.lines, taxes: d.taxes, flags: d.flags, approvals: d.approvals, payments: d.payments, paymentFlags: d.paymentFlags };
  return { ...record, chain: whoDidWhat(d, opts.stepLabel ? { stepLabel: opts.stepLabel } : {}) };
}
