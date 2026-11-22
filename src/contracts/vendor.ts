import { z } from "zod";
import { Person, TimelineEvent } from "./audit-view";

/**
 * Feature 9 — vendor management. What the vendor screens send and receive.
 *
 *   VendorList / VendorDetail      what the vendor master screens render (server → UI)
 *   OnboardVendorInput             "add a new vendor" form
 *   BankDetailsInput               "new bank details" form (a change needs a second person)
 *   StatusChangeInput              hold / lift hold — always with a reason
 *
 * Privacy: a full bank account number is accepted on input but NEVER returned — screens get the
 * last 4 digits only. Who did what (onboarded, approved, verified) comes from the audit trail.
 * Rules for changing this file: docs/rules/contracts.md.
 */

/** pending_review = new, not approved yet (cannot be paid normally) · active · on_hold = frozen. */
export const VENDOR_STATUSES = ["pending_review", "active", "on_hold"] as const;
export const VendorStatus = z.enum(VENDOR_STATUSES);
export type VendorStatus = z.infer<typeof VendorStatus>;

export const PAYMENT_METHODS = ["EFT", "CARD", "CHEQUE"] as const;
/** How a bank-change request reached us (stored on the bank account row, shown to the verifier). */
export const BANK_CHANNELS = ["phone_callback_verified", "vendor_portal", "email_request", "entered_in_app"] as const;

/** A refusal or a warning, with a stable code and a sentence the UI shows as is. */
export const VendorReason = z.object({ code: z.string(), message: z.string() });
export type VendorReason = z.infer<typeof VendorReason>;

const optionalText = z
  .string()
  .trim()
  .nullish()
  .transform((s) => (s ? s : null));

// ---------------------------------------------------------------------------------------------
// Inputs (UI → server). The server re-checks everything; these only shape the data.
// ---------------------------------------------------------------------------------------------

export const BankDetailsInput = z.object({
  /** 3 digits. */
  institution: z.string().trim(),
  /** 5 digits (branch). */
  transit: z.string().trim(),
  /** 7–12 digits; spaces are ignored. */
  account: z.string().transform((s) => s.replace(/\s/g, "")),
  currency: z.enum(["CAD", "USD"]).default("CAD"),
  channel: z.enum(BANK_CHANNELS).default("entered_in_app"),
});
export type BankDetailsInput = z.input<typeof BankDetailsInput>;

export const OnboardVendorInput = z.object({
  legalName: z.string().trim().min(1, "The vendor's legal name is required."),
  category: z.string().trim().min(1, "Pick a category."),
  address: optionalText,
  provinceOrState: optionalText,
  country: z.string().trim().toUpperCase().length(2).default("CA"),
  gstHstNumber: optionalText,
  qstNumber: optionalText,
  paymentTermsDays: z.number().int().min(0).max(365).default(30),
  preferredPaymentMethod: z.enum(PAYMENT_METHODS).default("EFT"),
  acceptsCardPayment: z.boolean().default(false),
  apContactEmail: z.email().nullish().transform((s) => s ?? null),
  requiresPo: z.boolean().default(false),
  defaultGlAccount: optionalText,
  /** Optional first bank account. It starts `pending`; a second person verifies it. */
  bankAccount: BankDetailsInput.nullish().transform((b) => b ?? null),
  /** The invoice that revealed this vendor (VENDOR_UNKNOWN). It is re-checked right after. */
  fromInvoiceId: optionalText,
});
export type OnboardVendorInput = z.input<typeof OnboardVendorInput>;

export const StatusChangeInput = z.object({
  reason: z.string().trim().min(1, "Give a reason; it is kept in the audit trail."),
});
export type StatusChangeInput = z.input<typeof StatusChangeInput>;

export const RejectBankChangeInput = StatusChangeInput;
export type RejectBankChangeInput = z.input<typeof RejectBankChangeInput>;

/** "Onboard this vendor" prefilled from an invoice the clerk is looking at. */
export const VendorDraft = z.object({
  fromInvoiceId: z.string(),
  legalName: z.string().nullable(),
  address: z.string().nullable(),
  provinceOrState: z.string().nullable(),
  country: z.string().nullable(),
  gstHstNumber: z.string().nullable(),
  qstNumber: z.string().nullable(),
  apContactEmail: z.string().nullable(),
  /** Vendors already in the master that look like this one (check before onboarding). */
  similarVendors: z.array(z.object({ vendorId: z.string(), legalName: z.string(), why: z.string() })),
});
export type VendorDraft = z.infer<typeof VendorDraft>;

// ---------------------------------------------------------------------------------------------
// Results of write actions.
// ---------------------------------------------------------------------------------------------

export const VendorActionResult = z.object({
  vendorId: z.string(),
  status: VendorStatus,
  /** Not blocking: e.g. "another vendor already uses this email domain". */
  warnings: z.array(VendorReason),
  /** Open invoices whose checks were re-run because of this change (flags may have cleared). */
  revalidatedInvoices: z.array(z.string()),
});
export type VendorActionResult = z.infer<typeof VendorActionResult>;

export const BankActionResult = z.object({
  vendorId: z.string(),
  version: z.number().int(),
  status: z.enum(["pending", "verified", "rejected"]),
  last4: z.string(),
  revalidatedInvoices: z.array(z.string()),
});
export type BankActionResult = z.infer<typeof BankActionResult>;

// ---------------------------------------------------------------------------------------------
// Screen 1 — the vendor master list.
// ---------------------------------------------------------------------------------------------

export const VendorListQuery = z.object({
  /** Matches id, legal name, GST/HST number or contact email. */
  search: z.string().trim().optional(),
  status: VendorStatus.optional(),
  category: z.string().optional(),
  /** Only vendors with a bank change waiting for a second person. */
  pendingBankChange: z.boolean().optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(50),
});
export type VendorListQuery = z.input<typeof VendorListQuery>;

export const VendorRow = z.object({
  vendorId: z.string(),
  legalName: z.string(),
  category: z.string(),
  status: VendorStatus,
  provinceOrState: z.string().nullable(),
  country: z.string().nullable(),
  preferredPaymentMethod: z.string().nullable(),
  requiresPo: z.boolean(),
  /** Last 4 digits of the account payments may use; null = no verified account. */
  verifiedAccountLast4: z.string().nullable(),
  pendingBankChange: z.boolean(),
  openInvoices: z.number().int(),
  openFlags: z.number().int(),
  /** Approved / scheduled / paid this calendar year, in CAD cents. */
  spendYtdCadCents: z.number().int(),
  onboardedAt: z.string().nullable(),
});
export type VendorRow = z.infer<typeof VendorRow>;

export const VendorList = z.object({
  rows: z.array(VendorRow),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  /** For the filter dropdowns. */
  categories: z.array(z.string()),
  counts: z.object({ pending_review: z.number().int(), active: z.number().int(), on_hold: z.number().int(), pendingBankChanges: z.number().int() }),
});
export type VendorList = z.infer<typeof VendorList>;

// ---------------------------------------------------------------------------------------------
// Screen 2 — one vendor.
// ---------------------------------------------------------------------------------------------

export const BankAccountView = z.object({
  version: z.number().int(),
  /** pending | verified | rejected | superseded | closed */
  status: z.string(),
  currency: z.string(),
  last4: z.string(),
  channel: z.string().nullable(),
  changedAt: z.string().nullable(),
  requestedBy: Person.nullable(),
  verifiedBy: Person.nullable(),
  verifiedAt: z.string().nullable(),
});
export type BankAccountView = z.infer<typeof BankAccountView>;

/** Whether the viewer may press a button, and if not, why (shown as the button's tooltip). */
export const AllowedAction = z.object({ allowed: z.boolean(), reason: z.string().nullable() });
export type AllowedAction = z.infer<typeof AllowedAction>;

export const VendorDetail = z.object({
  vendor: z.object({
    vendorId: z.string(),
    legalName: z.string(),
    category: z.string(),
    status: VendorStatus,
    /** Reason given for the current status (e.g. why it is on hold); null if none recorded. */
    statusReason: z.string().nullable(),
    address: z.string().nullable(),
    provinceOrState: z.string().nullable(),
    country: z.string().nullable(),
    gstHstNumber: z.string().nullable(),
    qstNumber: z.string().nullable(),
    paymentTermsDays: z.number().int().nullable(),
    earlyPayDiscount: z.string().nullable(),
    preferredPaymentMethod: z.string().nullable(),
    acceptsCardPayment: z.boolean(),
    apContactEmail: z.string().nullable(),
    requiresPo: z.boolean(),
    defaultGlAccount: z.string().nullable(),
    onboardedAt: z.string().nullable(),
    /** null for vendors that came with the dataset (onboarded before this system). */
    onboardedBy: Person.nullable(),
    approvedBy: Person.nullable(),
  }),
  /** Newest first. Last 4 digits only. */
  bankAccounts: z.array(BankAccountView),
  contracts: z.array(z.object({ contractId: z.string(), description: z.string(), billingType: z.string(), status: z.string(), startDate: z.string(), endDate: z.string() })),
  purchaseOrders: z.array(z.object({ poId: z.string(), description: z.string().nullable(), status: z.string(), totalAmountCents: z.number().int(), currency: z.string() })),
  /** Most recent first (max 25). */
  invoices: z.array(
    z.object({
      invoiceId: z.string(),
      invoiceNumber: z.string().nullable(),
      invoiceDate: z.string().nullable(),
      status: z.string(),
      totalCents: z.number().int().nullable(),
      currency: z.string().nullable(),
      openFlags: z.number().int(),
    }),
  ),
  /** Every vendor and bank-account event, oldest first, refusals included. */
  timeline: z.array(TimelineEvent),
  allowedActions: z.object({
    approve: AllowedAction,
    hold: AllowedAction,
    releaseHold: AllowedAction,
    requestBankChange: AllowedAction,
    verifyBankChange: AllowedAction,
    rejectBankChange: AllowedAction,
  }),
});
export type VendorDetail = z.infer<typeof VendorDetail>;
