import { z } from "zod";

/**
 * Feature 7 — payments. What the payments service hands to the dashboard and to other features.
 * The same shapes, with an example and where to get them: docs/payment-data.md (keep both in step).
 * Rules for changing this file: docs/rules/contracts.md.
 */

const Cents = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const PositiveCents = Cents.positive();
const IsoDate = z.iso.date();
const IsoDateTime = z.iso.datetime({ offset: true });
/** Decimal string, never a float in money math. "1" for CAD. */
const DecimalRate = z.string().regex(/^\d+(\.\d+)?$/);

// ---------------------------------------------------------------------------------------------
// Payment attempt lifecycle. A retry is a new attempt; a final status never moves again.
// ---------------------------------------------------------------------------------------------
export const PaymentStatus = z.enum(["scheduled", "on_hold", "released", "settled", "failed", "cancelled"]);
export type PaymentStatus = z.infer<typeof PaymentStatus>;

export const PAYMENT_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  scheduled: ["released", "cancelled", "on_hold"],
  on_hold: ["scheduled", "cancelled"],
  released: ["settled", "failed"],
  settled: [],
  failed: [],
  cancelled: [],
};

export function canMovePayment(from: PaymentStatus, to: PaymentStatus): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}

/** Invoice statuses payments works with, named as in docs/explainers/brim-ap-diagrams.md. */
export const PayableInvoiceStatus = z.enum(["Approved", "PaymentScheduled", "Paid"]);
export type PayableInvoiceStatus = z.infer<typeof PayableInvoiceStatus>;

export const PaymentMethod = z.enum(["EFT", "CHEQUE", "CARD"]);
export type PaymentMethod = z.infer<typeof PaymentMethod>;

export const Currency = z.enum(["CAD", "USD"]);
export type Currency = z.infer<typeof Currency>;

export const Person = z.object({
  userId: z.string().min(1),
  name: z.string().min(1),
});
export type Person = z.infer<typeof Person>;

// ---------------------------------------------------------------------------------------------
// Failures: one lookup gives each bank reason its retry rule and its urgency.
// ---------------------------------------------------------------------------------------------
export const FailureCode = z.enum([
  "BANK_ERROR",
  "INSUFFICIENT_FUNDS",
  "ACCOUNT_CLOSED",
  "INVALID_ACCOUNT",
  "INVALID_BRANCH",
  "NAME_MISMATCH",
  "CURRENCY_NOT_SUPPORTED",
  "ACCOUNT_FROZEN",
  "FRAUD_HOLD",
]);
export type FailureCode = z.infer<typeof FailureCode>;

/** What happens to the failed attempt's own retry. */
export const RetryRule = z.enum(["RETRY_ALLOWED", "FIX_BANK_DETAILS", "ESCALATE"]);
export type RetryRule = z.infer<typeof RetryRule>;

/** What happens to the supplier's other payments. */
export const FlagUrgency = z.enum(["critical", "high", "low"]);
export type FlagUrgency = z.infer<typeof FlagUrgency>;

export interface FailureReason {
  message: string;
  nextStep: string;
  retryRule: RetryRule;
  urgency: FlagUrgency;
}

/** Adding a bank reason is one line here (and one in FailureCode). */
export const FAILURE_REASONS: Readonly<Record<FailureCode, FailureReason>> = {
  BANK_ERROR: {
    message: "The bank had a temporary error and did not process the transfer.",
    nextStep: "Retry the payment.",
    retryRule: "RETRY_ALLOWED",
    urgency: "low",
  },
  INSUFFICIENT_FUNDS: {
    message: "Harborline's account did not have enough funds when the transfer ran.",
    nextStep: "Confirm funds are available, then retry.",
    retryRule: "RETRY_ALLOWED",
    urgency: "low",
  },
  ACCOUNT_CLOSED: {
    message: "The supplier's bank account is closed.",
    nextStep: "Get new details from the supplier's contact on file, and have a second person verify them before retrying.",
    retryRule: "FIX_BANK_DETAILS",
    urgency: "high",
  },
  INVALID_ACCOUNT: {
    message: "The account number does not exist at the supplier's bank.",
    nextStep: "Correct and verify the supplier's bank details, then retry.",
    retryRule: "FIX_BANK_DETAILS",
    urgency: "high",
  },
  INVALID_BRANCH: {
    message: "The transit (branch) number is not valid.",
    nextStep: "Correct and verify the supplier's bank details, then retry.",
    retryRule: "FIX_BANK_DETAILS",
    urgency: "high",
  },
  NAME_MISMATCH: {
    message: "The account holder's name does not match the supplier's legal name.",
    nextStep: "Confirm the account belongs to the supplier and verify it, then retry.",
    retryRule: "FIX_BANK_DETAILS",
    urgency: "high",
  },
  CURRENCY_NOT_SUPPORTED: {
    message: "The supplier's account cannot receive this currency.",
    nextStep: "Get and verify an account that accepts this currency, then retry.",
    retryRule: "FIX_BANK_DETAILS",
    urgency: "high",
  },
  ACCOUNT_FROZEN: {
    message: "The supplier's account is frozen by their bank.",
    nextStep: "Get new bank details from the supplier and have a second person verify them before retrying.",
    retryRule: "FIX_BANK_DETAILS",
    urgency: "high",
  },
  FRAUD_HOLD: {
    message: "The bank held the transfer as possible fraud.",
    nextStep: "All payments to this supplier are stopped. The Controller reviews and clears the hold before any retry.",
    retryRule: "ESCALATE",
    urgency: "critical",
  },
};

export const PaymentFailure = z.object({
  code: FailureCode,
  message: z.string().min(1),
  nextStep: z.string().min(1),
  retryRule: RetryRule,
  urgency: FlagUrgency,
});
export type PaymentFailure = z.infer<typeof PaymentFailure>;

// ---------------------------------------------------------------------------------------------
// Urgency flags. Payments keep their own list: a critical flag belongs to a supplier, not to one
// invoice, so the shared invoice Flag (src/contracts/flag.ts) does not fit.
// ---------------------------------------------------------------------------------------------
export const FlagScope = z.enum(["supplier", "payment"]);
export type FlagScope = z.infer<typeof FlagScope>;

export const PaymentFlag = z.object({
  flagId: z.string().min(1),
  urgency: FlagUrgency,
  reasonCode: FailureCode,
  message: z.string().min(1),
  /** supplier: applies to every payment to vendorId. payment: only the attempt paymentId. */
  scope: FlagScope,
  vendorId: z.string().min(1),
  /** The failed attempt that raised the flag. */
  paymentId: z.string().min(1),
  createdAt: IsoDateTime,
  clearedBy: Person.nullable(),
  clearedAt: IsoDateTime.nullable(),
  clearNote: z.string().nullable(),
  /** True when it cleared itself (bank details verified, retry scheduled); clearedBy is then null. */
  clearedAutomatically: z.boolean(),
});
export type PaymentFlag = z.infer<typeof PaymentFlag>;

// ---------------------------------------------------------------------------------------------
// Records the dashboard reads.
// ---------------------------------------------------------------------------------------------
/** Which bank account version an attempt pays. Only the last 4 digits ever leave the server. */
export const BankAccountRef = z.object({
  vendorId: z.string().min(1),
  version: z.number().int().positive(),
  last4: z.string().regex(/^\d{4}$/),
});
export type BankAccountRef = z.infer<typeof BankAccountRef>;

/** One payment attempt. A retry is a new record with attemptNo + 1. */
export const PaymentRecord = z.object({
  paymentId: z.string().min(1),
  invoiceId: z.string().min(1),
  attemptNo: z.number().int().positive(),
  status: PaymentStatus,
  method: PaymentMethod,
  currency: Currency,
  /** Always the full invoice total, in the invoice currency. */
  amountCents: PositiveCents,
  /** At the invoice-date rate; equals amountCents for CAD. */
  amountCadCents: PositiveCents,
  fxRateToCad: DecimalRate,
  /** The pay date the clerk picked (defaults to the due date, weekends moved to the Friday before). */
  scheduledDate: IsoDate,
  bankAccount: BankAccountRef,
  releasedAt: IsoDateTime.nullable(),
  settledAt: IsoDateTime.nullable(),
  failedAt: IsoDateTime.nullable(),
  failure: PaymentFailure.nullable(),
  cancelledAt: IsoDateTime.nullable(),
  cancelledBy: Person.nullable(),
  cancelReason: z.string().nullable(),
  holdReason: z.string().nullable(),
  preparedBy: Person,
  releasedBy: Person.nullable(),
  /** Flags that apply to this attempt: its own, plus its supplier's. */
  flags: z.array(PaymentFlag),
});
export type PaymentRecord = z.infer<typeof PaymentRecord>;

/** An invoice as the dashboard needs it. */
export const InvoiceRecord = z.object({
  invoiceId: z.string().min(1),
  vendorInvoiceNumber: z.string().min(1),
  vendorId: z.string().min(1),
  vendorName: z.string().min(1),
  currency: Currency,
  totalCents: PositiveCents,
  /** At the invoice-date rate; equals totalCents for CAD. */
  totalCadCents: PositiveCents,
  dueDate: IsoDate,
  requestedBy: Person,
  approvedBy: z.array(Person),
  status: PayableInvoiceStatus,
});
export type InvoiceRecord = z.infer<typeof InvoiceRecord>;

/** Can the signed-in person release this payment? Reason codes are listed in docs/payment-data.md. */
export const ReleaseCheck = z.object({
  allowed: z.boolean(),
  reasons: z.array(
    z.object({
      code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
      message: z.string().min(1),
    }),
  ),
});
export type ReleaseCheck = z.infer<typeof ReleaseCheck>;

/** One invoice's payment: its latest attempt, every attempt oldest first, and its flags. */
export const PaymentRow = z.object({
  invoice: InvoiceRecord,
  current: PaymentRecord,
  attempts: z.array(PaymentRecord).min(1),
  /** Every flag on any of this invoice's attempts, newest first, open and cleared. */
  flags: z.array(PaymentFlag),
  /** For the signed-in person. */
  releaseCheck: ReleaseCheck,
});
export type PaymentRow = z.infer<typeof PaymentRow>;

export const PaymentsView = z.object({
  /** Sorted by current.scheduledDate, earliest first. */
  payments: z.array(PaymentRow),
  /** Approved invoices with no payment attempt yet, sorted by dueDate. */
  awaitingPayment: z.array(InvoiceRecord),
});
export type PaymentsView = z.infer<typeof PaymentsView>;
