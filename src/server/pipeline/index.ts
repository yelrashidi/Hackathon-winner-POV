/**
 * The invoice pipeline on the database: each feature's pure engine, wired to Postgres with
 * authorize() → one transaction → audit rows → fire(). Route handlers and server actions call these.
 *
 *   1–2 → in  ingestFromIntake(message, { classification, readings })   intake + extraction hand-off
 *             ingestInvoice(validationInput, { source })      save + validation (4) + coding (3)
 *   review    editInvoice(actor, id, patch)                   correct fields → analysis re-runs
 *             codeInvoiceLine / acceptConfidentLines          a person confirms coding (3)
 *             overrideFlag / resolveFlag                      (from features/validation)
 *   6         submitForApproval(actor, id)                    route + PendingApproval / OnHold
 *             decideApproval(actor, id, body)                 approve / reject a step
 *   8         features/audit                                  the auditor's view of all of it
 *
 *   7         paymentsDb.*                                    Katie's payments service (on Postgres) + the Admin release rule
 */
export { ingestInvoice, revalidateInvoice, reanalyseWithin, editInvoice, IngestError, type IngestOptions, type AnalysisResult, type InvoicePatch } from "./ingest";
export { codeWithin, codeInvoiceLine, acceptConfidentLines, loadCodingContext, invoiceCoding, CodingError } from "./coding";
export { submitForApproval, decideApproval, previewApproval, releaseHold, loadApprovalContext, PostgresApprovalStore, ApprovalFlowError } from "./approvals";
export { invoiceInputFromDb } from "./input";
export { ingestFromIntake, readingToValidationInput, intakeInvoiceId, inboxMessageId, type IntakeOutcome, type IntakeIngestResult, type IntakeIngestOptions, type IntakeAttachmentFile } from "./intake";
export { paymentsDb } from "./payments";
export { enterInvoiceFields, ManualFields } from "./manual-entry";
export { saveUploadedDocument, readDocumentFile, UPLOAD_DIR } from "./documents";
export { listPolicies, updatePolicy, setUserAvailability, listDirectory, AdminError, type PolicyPatch, type AvailabilityPatch } from "./admin";
