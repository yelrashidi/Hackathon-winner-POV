import type { Actor } from "@/contracts/actor";
import type { AuditInvoiceDetail, AuditInvoiceList, AuditInvoiceListQuery } from "@/contracts/audit-view";
import { getInvoiceAuditDetail, listAuditInvoices } from "@/server/features/audit";
import type { Opts } from "./shared";

/**
 * The audit trail — the Auditor's alone (features/audit, Andrew's services, authorize "audit.view";
 * every other role gets Forbidden). The Auditor sees EVERY invoice, in progress or finished: the
 * brief's Auditor is "read-only, sees everything" (docs/explainers/Brim_AP_Automation_Challenge_Explained.md).
 */
/** Invoices whose outcome is decided — a filter option on the audit list, no longer a limit. */
export const PAST_STATUSES = ["Approved", "PaymentScheduled", "Paid", "Closed", "Voided"];

export function auditList(actor: Actor, query: AuditInvoiceListQuery, opts: Opts = {}): Promise<AuditInvoiceList> {
  return listAuditInvoices(actor, query, opts);
}

/** Null when the invoice does not exist. */
export async function auditDetail(actor: Actor, invoiceId: string, opts: Opts = {}): Promise<AuditInvoiceDetail | null> {
  try {
    return await getInvoiceAuditDetail(actor, invoiceId, opts);
  } catch (err) {
    if (err instanceof Error && err.name === "AuditNotFound") return null;
    throw err;
  }
}
