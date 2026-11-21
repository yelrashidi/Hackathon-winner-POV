// TEMP: dashboard-side types until the payment session publishes docs/payment-data.md.
// Shapes follow docs/architecture/data-model.md (payments, invoices). When the real format
// lands, replace this file with an import from the payment contract and fix what breaks.

/**
 * Payment statuses from the data model. "approved" is an invoice status, not a payment one.
 * TEMP: "on_hold" is the payment session's planned hold (a bank-detail failure holds the vendor's
 * other payments to that account); the name is not final until docs/payment-data.md exists.
 */
export type PaymentStatus = "scheduled" | "released" | "settled" | "failed" | "cancelled" | "on_hold";

export type PaymentMethod = "EFT" | "CHEQUE" | "CARD";

export type Currency = "CAD" | "USD";

/** Failure reasons from docs/payment-decisions.md → Failed payments. */
export type FailureCode =
  | "BANK_ERROR"
  | "INSUFFICIENT_FUNDS"
  | "ACCOUNT_CLOSED"
  | "INVALID_ACCOUNT"
  | "INVALID_BRANCH"
  | "NAME_MISMATCH"
  | "CURRENCY_NOT_SUPPORTED"
  | "ACCOUNT_FROZEN"
  | "FRAUD_HOLD";

export type Person = {
  userId: string;
  name: string;
};

/** An invoice as the dashboard needs it. */
export type InvoiceRecord = {
  invoiceId: string;
  vendorInvoiceNumber: string;
  vendorId: string;
  vendorName: string;
  currency: Currency;
  totalCents: number;
  /** Total converted to CAD at the invoice-date rate; equals totalCents for CAD invoices. */
  totalCadCents: number;
  dueDate: string; // YYYY-MM-DD
  requestedBy: Person;
  approvedBy: Person[];
  status: "approved" | "payment_scheduled" | "paid";
};

/** One payment attempt — one row of the payments table. A retry is a new row. */
export type PaymentRecord = {
  paymentId: string;
  invoiceId: string;
  attemptNo: number;
  status: PaymentStatus;
  method: PaymentMethod;
  currency: Currency;
  amountCents: number;
  amountCadCents: number;
  /** Decimal string, never a float in money math. "1" for CAD. */
  fxRateToCad: string;
  scheduledDate: string; // YYYY-MM-DD
  releasedAt: string | null;
  settledAt: string | null;
  failedAt: string | null;
  failureCode: FailureCode | null;
  cancelReason: string | null;
  holdReason: string | null;
  preparedBy: Person;
  releasedBy: Person | null;
};
