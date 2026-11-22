import type { CodingIndex } from "./history";

/**
 * The reference data coding reads. Shaped like the seeded tables (docs/architecture/data-model.md)
 * so a DB loader maps straight onto it; kept free of any ORM so coding stays pure and testable.
 */

export interface GlAccountRef {
  number: string;
  name: string;
  /** asset | liability | expense … Only expense accounts can be put on an invoice line. */
  type: string;
  /** gl_accounts.notes, e.g. "Expense items under $1,000 per unit" (read for the capitalisation check). */
  notes: string | null;
}

export interface CodingDepartmentRef {
  id: string;
  name: string;
}

export interface CodingVendorRef {
  id: string;
  legalName: string;
  category: string;
  /** vendors.default_gl_account; used when the vendor has no usable coded history. */
  defaultGlAccount: string | null;
}

export interface CodingTaxCodeRef {
  code: string;
  /** Decimal as a string, e.g. "0.07". */
  rate: string;
  /** all | goods */
  appliesTo: string;
  /** yes | no | n/a — recoverable tax is an asset (input tax credit), not an expense. */
  recoverable: string;
  /** Receivable account for recoverable tax (1160 GST/HST, 1165 QST). */
  glAccount: string | null;
}

export interface CodingPurchaseOrderRef {
  id: string;
  vendorId: string;
  departmentId: string | null;
  /** open | partially_invoiced | closed */
  status: string;
}

export interface CodingUserRef {
  id: string;
  fullName: string;
  departmentId: string;
}

/** One line someone already coded: history, or a line a person accepted / changed since. */
export interface CodedLine {
  invoiceId: string;
  vendorId: string;
  /** As printed; credit notes find the invoice they reverse by it. */
  invoiceNumber: string | null;
  /** ISO date; newest lines are the strongest evidence. */
  invoiceDate: string;
  lineNo: number;
  description: string;
  amountCents: number;
  glAccount: string;
  departmentId: string;
  /** historical = seeded from the dataset; accepted / changed = a person's decision in the app. */
  source: "historical" | "accepted" | "changed";
  /** When a person decided (null for history); orders lines on the same date. */
  codedAt: string | null;
}

export interface CodingContext {
  glAccounts: ReadonlyMap<string, GlAccountRef>;
  departments: ReadonlyMap<string, CodingDepartmentRef>;
  vendors: ReadonlyMap<string, CodingVendorRef>;
  taxCodes: ReadonlyMap<string, CodingTaxCodeRef>;
  purchaseOrders: readonly CodingPurchaseOrderRef[];
  users: ReadonlyMap<string, CodingUserRef>;
  /** The Accounts Payable control account the journal credits (2100 in the chart). */
  apControlAccount: string | null;
  /** Everything coded so far, indexed for fast lookups (history.ts). */
  history: CodingIndex;
}
