/**
 * What the duplicate check compares an invoice against. Pure data, no I/O: `db/load-context.ts`
 * builds it from Postgres with indexed queries (only this vendor's invoices, only card charges
 * near the amount), `dataset/` builds it from the CSVs for the batch and history replays.
 */

/** An invoice — the one being checked, or one already on record. */
export interface InvoiceOnRecord {
  invoiceId: string;
  /** Resolved vendor (validation's matchVendor). Null = unknown vendor: only the file hash can match. */
  vendorId: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  receivedDate: string | null;
  currency: string | null;
  totalCents: number | null;
  totalCadCents: number | null;
  /** Workflow status (state machine or legacy CSV word); voided / rejected are ignored. */
  status: string;
  isCreditNote: boolean;
  /** sha256 of the source document, when it came from a file. */
  documentSha256: string | null;
  /** Tie-break for "which copy came second" when the received dates are equal (ISO timestamp). */
  createdAt: string | null;
}

export interface CardTxnRef {
  id: string;
  postedDate: string;
  merchantDescriptor: string;
  amountCents: number;
  currency: string;
  amountCadCents: number;
  /** employee_card | ap_virtual_card */
  source: string;
  cardholderId: string | null;
  /** Set when already matched (card_transactions.vendor_id); otherwise matched by merchant name. */
  vendorId: string | null;
}

export interface VendorName {
  id: string;
  legalName: string;
}

export interface DuplicateContext {
  /** Invoices on record. May include the checked invoice itself; it is skipped by id. */
  invoices: readonly InvoiceOnRecord[];
  cardTransactions: readonly CardTxnRef[];
  /** Every vendor, for matching card merchant descriptors to a vendor. */
  vendors: readonly VendorName[];
  /**
   * Approval amount tiers (CAD cents) from the approval policies, for SPLIT_IF_NOT_DUPLICATE.
   * Empty = no split facts are reported.
   */
  approvalThresholdsCadCents?: readonly number[];
}
