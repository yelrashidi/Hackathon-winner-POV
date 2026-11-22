import { ValidationInput, type ValidationInputDraft } from "@/contracts/validation";
import { validateInvoice, type ValidationContext } from "@/server/features/validation";
import { readCsv } from "@/server/features/validation/dataset/csv";
import { approvalThresholdsFrom } from "@/server/features/validation/dataset/load-context";
import { parseMoneyToCents } from "@/server/features/validation/lib/money";
import type { CardTxnRef, DuplicateContext, InvoiceOnRecord, VendorName } from "./context";

/**
 * The duplicate context from the dataset CSVs, for the batch and history replays
 * (scripts/duplicates-batch.ts) and the tests. The database path is db/load-context.ts.
 */

type Row = Record<string, string>;
const orNull = (s: string | undefined) => (s && s.trim() !== "" ? s : null);
const cents = (s: string | undefined) => (s && s.trim() !== "" ? parseMoneyToCents(s) : null);

export function historyFromCsv(rows: Row[]): InvoiceOnRecord[] {
  return rows.map((r) => {
    const total = cents(r.total);
    return {
      invoiceId: r.invoice_id!,
      vendorId: orNull(r.vendor_id),
      invoiceNumber: orNull(r.vendor_invoice_number),
      invoiceDate: orNull(r.invoice_date),
      receivedDate: orNull(r.received_date),
      currency: orNull(r.currency),
      totalCents: total,
      totalCadCents: cents(r.total_cad),
      status: r.status!,
      isCreditNote: (total ?? 0) < 0,
      documentSha256: null,
      createdAt: null,
    };
  });
}

export function cardTransactionsFromCsv(rows: Row[]): CardTxnRef[] {
  return rows.map((r) => ({
    id: r.txn_id!,
    postedDate: r.posted_date!,
    merchantDescriptor: r.merchant_descriptor!,
    amountCents: cents(r.amount) ?? 0,
    currency: r.currency!,
    amountCadCents: cents(r.amount_cad) ?? 0,
    source: r.source!,
    cardholderId: orNull(r.cardholder_user_id),
    vendorId: null,
  }));
}

export function vendorNamesFromCsv(rows: Row[]): VendorName[] {
  return rows.map((r) => ({ id: r.vendor_id!, legalName: r.legal_name! }));
}

export function loadDatasetDuplicateContext(dir?: string): DuplicateContext {
  return {
    invoices: historyFromCsv(readCsv("invoices.csv", dir)),
    cardTransactions: cardTransactionsFromCsv(readCsv("card_transactions.csv", dir)),
    vendors: vendorNamesFromCsv(readCsv("vendors.csv", dir)),
    approvalThresholdsCadCents: approvalThresholdsFrom(readCsv("approval_policies.csv", dir)),
  };
}

/**
 * An extracted invoice as the duplicate check sees it. Vendor and CAD total come from validation
 * (one vendor for every stage), exactly as the analysis pass does it.
 */
export function incomingToRecord(draft: ValidationInputDraft, vctx: ValidationContext, opts: { documentSha256?: string | null; createdAt?: string | null } = {}): InvoiceOnRecord {
  const input = ValidationInput.parse(draft);
  const v = validateInvoice(input, vctx);
  return {
    invoiceId: input.invoiceId,
    vendorId: v.vendorId,
    invoiceNumber: input.invoiceNumber,
    invoiceDate: input.invoiceDate,
    receivedDate: input.receivedDate,
    currency: input.currency,
    totalCents: input.totalCents,
    totalCadCents: v.totalCadCents,
    status: "InReview",
    isCreditNote: input.documentType === "credit_note" || (input.totalCents ?? 0) < 0,
    documentSha256: opts.documentSha256 ?? null,
    createdAt: opts.createdAt ?? null,
  };
}
