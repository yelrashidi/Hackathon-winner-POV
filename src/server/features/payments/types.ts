import type { Currency, FailureCode, FlagScope, FlagUrgency, PaymentFailure, PaymentMethod, PaymentStatus } from "@/contracts/payment";
import type { ApprovalPolicy } from "@/contracts/approvals";
import type { Flag } from "@/contracts/flag";
import type { DirectoryUser } from "@/server/features/approvals";

/**
 * What payments keeps internally. People are stored as user ids; the read side turns them into
 * the contract's `Person`. Shapes of other features' data follow docs/payment-assumptions.md.
 */

export type InvoiceStatus = "Approved" | "PaymentScheduled" | "Paid" | (string & {});

/** A4 in payment-assumptions.md. */
export interface InvoiceRec {
  id: string;
  version: number;
  status: InvoiceStatus;
  vendorId: string;
  vendorInvoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  currency: Currency;
  totalCents: number;
  totalCadCents: number;
  fxRate: string;
  departmentId: string;
  requesterId: string;
  isCreditNote: boolean;
}

/** A6. Vendor fields payments reads. */
export interface VendorRec {
  id: string;
  legalName: string;
  status: string;
  /** Vendor master payment terms, for an invoice without a due date. */
  paymentTermsDays?: number | null;
}

/** A6. Field names follow Andrew's BankAccountVersion; currency / requestedBy / verifiedBy are ours. */
export type BankAccountStatus = "pending" | "verified" | "rejected" | "superseded" | "closed";

export interface BankAccountVersion {
  /** vendor_bank_accounts.id (set when loaded from the database); payments point at it. */
  accountId?: number;
  vendorId: string;
  version: number;
  status: BankAccountStatus;
  institution: string | null;
  transit: string | null;
  /** Full number: server only, never sent to the browser. */
  account: string | null;
  last4: string;
  currency: Currency;
  changedAt: string | null;
  channel: string | null;
  requestedBy: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  /** Why it was closed (the failure that made it unpayable). */
  closedReason: FailureCode | null;
}

/** What approvals tells payments about one invoice (A1, A3b). */
export interface ApprovalFacts {
  /** Everyone who signed any round, incl. whoever a delegate signed for. */
  approverIds: string[];
  /** What the current plan approved; null when no plan is current for this invoice version. */
  basis: { vendorId: string; currency: Currency; totalCents: number } | null;
}

export interface PaymentRec {
  paymentId: string;
  invoiceId: string;
  vendorId: string;
  attemptNo: number;
  status: PaymentStatus;
  method: PaymentMethod;
  currency: Currency;
  amountCents: number;
  amountCadCents: number;
  fxRateToCad: string;
  scheduledDate: string;
  /** When the attempt was scheduled (payments.created_at); absent on rows not read from the database. */
  scheduledAt?: string;
  bankVersion: number;
  bankLast4: string;
  releasedAt: string | null;
  settledAt: string | null;
  failedAt: string | null;
  failure: PaymentFailure | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancelReason: string | null;
  holdReason: string | null;
  preparedBy: string;
  releasedBy: string | null;
  /** The simulated bank's reference once released. */
  bankReference: string | null;
}

export interface FlagRec {
  flagId: string;
  urgency: FlagUrgency;
  reasonCode: FailureCode;
  message: string;
  scope: FlagScope;
  vendorId: string;
  invoiceId: string;
  paymentId: string;
  createdAt: string;
  clearedBy: string | null;
  clearedAt: string | null;
  clearNote: string | null;
  clearedAutomatically: boolean;
}

/** A9: one audit_events row. */
export interface AuditEvent {
  id: string;
  occurredAt: string;
  actorId: string;
  onBehalfOf: string | null;
  action: string;
  entityType: "payment" | "payment_flag" | "bank_account" | "invoice";
  entityId: string;
  invoiceId: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
}

/** What one read or action loads from the database (deps.ts loadData), for the invoices in view. */
export interface PaymentsData {
  users: Map<string, DirectoryUser>;
  vendors: Map<string, VendorRec>;
  /** Active payment_release policies. */
  policies: ApprovalPolicy[];
  invoices: InvoiceRec[];
  /** Every attempt of those invoices. */
  attempts: PaymentRec[];
  /** Every version of those suppliers' bank accounts. */
  bankAccounts: BankAccountVersion[];
  /** Every payment flag on those suppliers, open and cleared. */
  flags: FlagRec[];
  /** Open validation / duplicate flags per invoice (A5). */
  invoiceFlags: Map<string, Flag[]>;
  approvals: Map<string, ApprovalFacts | undefined>;
}
