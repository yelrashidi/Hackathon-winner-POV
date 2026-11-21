// TEMP: copy of the shapes in docs/payment-data.md (source of truth: src/contracts/payment.ts on
// the Katie branch). When we merge Katie, delete this file and import from "@/contracts/payment".

export type PaymentStatus = "scheduled" | "on_hold" | "released" | "settled" | "failed" | "cancelled";

export type PaymentMethod = "EFT" | "CHEQUE" | "CARD";

export type Currency = "CAD" | "USD";

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

export type RetryRule = "RETRY_ALLOWED" | "FIX_BANK_DETAILS" | "ESCALATE";

export type Urgency = "critical" | "high" | "low";

export type Person = {
  userId: string;
  name: string;
};

export type InvoiceRecord = {
  invoiceId: string;
  vendorInvoiceNumber: string;
  vendorId: string;
  vendorName: string;
  currency: Currency;
  totalCents: number;
  totalCadCents: number;
  dueDate: string; // YYYY-MM-DD
  requestedBy: Person;
  approvedBy: Person[];
  status: "Approved" | "PaymentScheduled" | "Paid";
};

export type PaymentFailure = {
  code: FailureCode;
  message: string;
  nextStep: string;
  retryRule: RetryRule;
  urgency: Urgency;
};

export type PaymentFlag = {
  flagId: string;
  urgency: Urgency;
  reasonCode: FailureCode;
  message: string;
  /** supplier: every payment to vendorId; payment: only paymentId */
  scope: "supplier" | "payment";
  vendorId: string;
  /** The failed attempt that raised it. */
  paymentId: string;
  createdAt: string;
  clearedBy: Person | null;
  /** Open = clearedAt is null. */
  clearedAt: string | null;
  clearNote: string | null;
  clearedAutomatically: boolean;
};

/** One payment attempt. A retry is a new record with attemptNo + 1. */
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
  bankAccount: { vendorId: string; version: number; last4: string };
  releasedAt: string | null;
  settledAt: string | null;
  failedAt: string | null;
  failure: PaymentFailure | null;
  cancelledAt: string | null;
  cancelledBy: Person | null;
  cancelReason: string | null;
  holdReason: string | null;
  preparedBy: Person;
  releasedBy: Person | null;
  /** Flags that apply to this attempt: its own, plus its supplier's. */
  flags: PaymentFlag[];
};

/** One invoice's payment: latest attempt, every attempt (oldest first), every flag (newest first). */
export type PaymentRow = {
  invoice: InvoiceRecord;
  current: PaymentRecord;
  attempts: PaymentRecord[];
  flags: PaymentFlag[];
};

export type PaymentsView = {
  payments: PaymentRow[];
  awaitingPayment: InvoiceRecord[];
};
