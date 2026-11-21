/**
 * The reference data validation checks an invoice against. Shaped like the seeded tables in
 * docs/architecture/data-model.md so a DB loader maps straight onto it. Kept separate from any
 * ORM so the rules stay pure: no I/O, no clock (`today` is passed in).
 *
 * Today `dataset/load-context.ts` builds it from the dataset CSVs; once the foundation lands, a
 * DB loader builds the same object (only this vendor's rows for the per-vendor lists).
 */

export interface VendorRef {
  id: string;
  legalName: string;
  category: string;
  /** Province / state code of the vendor's address. */
  province: string | null;
  /** ISO country code (CA, US). */
  country: string | null;
  gstHstNumber: string | null;
  qstNumber: string | null;
  paymentTermsDays: number | null;
  requiresPo: boolean;
  /** active | pending_review | on_hold, plus anything feature 9 adds (treated as not active). */
  status: string;
  contactEmail: string | null;
  onboardedAt: string | null;
  /** Count of this vendor's non-voided invoices on record: how established the vendor record is. */
  invoiceCount: number;
}

export type BankAccountStatus = "verified" | "pending" | "rejected" | "superseded";

/** One version of a vendor's bank account. A change is a new row, never an update. */
export interface BankAccountVersion {
  vendorId: string;
  version: number;
  status: BankAccountStatus;
  institution: string | null;
  transit: string | null;
  /** Full account number when known; older versions may only have the last 4 digits. */
  account: string | null;
  last4: string;
  /** When this version became the account on file (ISO date); null for the original. */
  changedAt: string | null;
  /** How the change was requested (phone_callback_verified, vendor_portal, email_request). */
  channel: string | null;
}

export interface PurchaseOrderRef {
  id: string;
  vendorId: string;
  departmentId: string | null;
  totalCents: number;
  currency: string;
  /** open | partially_invoiced | closed */
  status: string;
  issueDate: string | null;
}

export interface ContractRef {
  id: string;
  vendorId: string;
  description: string;
  /** fixed_monthly | rate_card | retainer | blanket */
  billingType: string;
  monthlyFeeCents: number | null;
  currency: string;
  hourlyRateCapCents: number | null;
  /** Decimal percent as a string, e.g. "12" means 12%. */
  fuelSurchargeCapPct: string | null;
  notToExceedMonthlyCents: number | null;
  startDate: string;
  endDate: string;
  autoRenew: boolean;
  /** active | expired | … */
  status: string;
}

/** An invoice already on record (history or earlier in the batch). */
export interface PriorInvoice {
  invoiceId: string;
  vendorId: string;
  invoiceNumber: string;
  invoiceDate: string;
  currency: string;
  /** Pre-tax, invoice currency, signed. */
  subtotalCents: number;
  totalCents: number;
  /** Converted at the invoice-date rate. */
  subtotalCadCents: number;
  totalCadCents: number;
  poId: string | null;
  contractId: string | null;
  /** Workflow status; `rejected` / `voided` invoices are ignored by every rule. */
  status: string;
  isCreditNote: boolean;
  /** Tax codes that appeared on its lines (e.g. ["EXEMPT"]). */
  taxCodes: string[];
}

export interface TaxCodeRef {
  code: string;
  description: string;
  /** Decimal as a string, e.g. "0.09975". */
  rate: string;
  /** all | goods */
  appliesTo: string;
  recoverable: string;
  glAccount: string | null;
}

export interface FxRate {
  date: string;
  /** Decimal as a string, e.g. "1.3709". */
  usdToCad: string;
}

/** A Harborline delivery location. Company reference data, not invoice data. */
export interface Office {
  id: string;
  city: string;
  province: string;
  /** First three characters of the postal code (FSA), e.g. "M5J". */
  postalPrefix: string;
}

export interface ValidationContext {
  /** "Today" for the run. Rules prefer the invoice's received date; this is the fallback. */
  today: string;
  vendors: readonly VendorRef[];
  bankAccounts: readonly BankAccountVersion[];
  purchaseOrders: readonly PurchaseOrderRef[];
  contracts: readonly ContractRef[];
  /** Invoices on record that rules compare against (PO balance, monthly caps, splits, credit refs). */
  priorInvoices: readonly PriorInvoice[];
  taxCodes: readonly TaxCodeRef[];
  fxRates: readonly FxRate[];
  offices: readonly Office[];
  /** Amount-tier boundaries from the approval policies, in CAD cents (e.g. 10k, 50k, 250k). */
  approvalThresholdsCadCents: readonly number[];
}
