import type { Actor } from "@/contracts/actor";
import type { AuditInvoiceDetail, AuditInvoiceList, AuditInvoiceListQuery } from "@/contracts/audit-view";
import { getInvoiceAuditDetail, listAuditInvoices } from "@/server/features/audit";
import type { Opts } from "./shared";

/**
 * The audit trail every dashboard role reads (features/audit, Andrew's services, authorize "audit.view").
 * The Auditor sees PAST invoices only (team plan 2026-11-21): ones whose outcome is decided —
 * approved, scheduled, paid, closed or voided. Invoices still in the clerk's or an approver's hands
 * are not theirs to see yet; every other role sees those too.
 */
export const PAST_STATUSES = ["Approved", "PaymentScheduled", "Paid", "Closed", "Voided"];

const pastOnly = (actor: Actor) => actor.role === "auditor";

export function auditList(actor: Actor, query: AuditInvoiceListQuery, opts: Opts = {}): Promise<AuditInvoiceList> {
  return listAuditInvoices(actor, pastOnly(actor) ? { ...query, statuses: PAST_STATUSES } : query, opts);
}

/** Null when the invoice does not exist, or is not yet past and the viewer is the Auditor. */
export async function auditDetail(actor: Actor, invoiceId: string, opts: Opts = {}): Promise<AuditInvoiceDetail | null> {
  try {
    const d = await getInvoiceAuditDetail(actor, invoiceId, opts);
    if (pastOnly(actor) && !PAST_STATUSES.includes(d.invoice.status)) return null;
    return d;
  } catch (err) {
    if (err instanceof Error && err.name === "AuditNotFound") return null;
    throw err;
  }
}
