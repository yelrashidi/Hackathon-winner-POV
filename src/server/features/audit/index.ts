/**
 * Feature 8 — audit. Public surface for the auditor dashboard (route handlers / server actions call
 * these; every one checks the actor is an auditor and logs a refused attempt).
 *
 *   listAuditInvoices(actor, query)        Screen 1: the invoice table
 *   getInvoiceAuditDetail(actor, id)       Screen 2: everything about one invoice
 *   getPaymentAuditDetail(actor, payId)    Screen 2, entered from a payment
 *   exportAuditCsv(actor, { from, to, invoiceId })   the auditor export
 *
 * Writing audit events is NOT here: that is src/server/core/audit.ts (emit / withAction).
 */
export { listAuditInvoices } from "./list";
export { getInvoiceAuditDetail, getPaymentAuditDetail } from "./detail";
export { exportAuditCsv, csvCell, AUDIT_CSV_COLUMNS, type AuditExportQuery } from "./export";
export { controlChecks } from "./controls";
export { describeEvent } from "./timeline";
export { AuditNotFound } from "./shared";
