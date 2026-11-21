import type { FlagSeverity } from "@/contracts/flag";

/**
 * Every flag code validation can raise: default severity, the rule file that raises it, and one
 * line on why it matters. Single source for the UI legend, the feature doc and the tests.
 *
 * Codes are stable once a UI or test uses them (CLAUDE.md). PO_OVER_BALANCE and
 * SPLIT_INVOICE_SUSPECTED are read by approvals (src/contracts/approvals.ts) — never rename them.
 *
 * Severity: block = submit refused until fixed or overridden with a note · warn = needs a human
 * look (some add an approval step or a hold in approvals) · info = context only.
 */
export type RuleGroup =
  | "completeness"
  | "arithmetic"
  | "tax"
  | "vendor"
  | "bank"
  | "po"
  | "contract"
  | "dates"
  | "fx"
  | "split"
  | "engine";

export interface CodeInfo {
  severity: FlagSeverity;
  rule: RuleGroup;
  why: string;
}

export const FLAG_CODES = {
  // completeness
  MISSING_REQUIRED_FIELD: { severity: "block", rule: "completeness", why: "A field every invoice needs is empty, so it cannot be checked or paid." },
  INVALID_DATE: { severity: "block", rule: "completeness", why: "A date is not a real calendar day (e.g. 2026-02-30); it is ignored by every date check until corrected." },
  LOW_CONFIDENCE_FIELD: { severity: "warn", rule: "completeness", why: "Extraction was unsure of this value; compare it with the document." },
  CURRENCY_UNSUPPORTED: { severity: "block", rule: "completeness", why: "Only CAD and USD can be converted and paid." },

  // arithmetic
  ARITH_LINE_MISMATCH: { severity: "block", rule: "arithmetic", why: "Quantity × unit price does not equal the line amount." },
  ARITH_SUBTOTAL_MISMATCH: { severity: "block", rule: "arithmetic", why: "The line amounts do not add up to the subtotal." },
  ARITH_TOTAL_MISMATCH: { severity: "block", rule: "arithmetic", why: "Subtotal plus taxes does not equal the total." },
  CREDIT_NOTE_SIGN: { severity: "block", rule: "arithmetic", why: "Credit notes carry negative amounts and invoices positive ones; the signs disagree with the document type." },
  CREDIT_NOTE_NO_REFERENCE: { severity: "warn", rule: "arithmetic", why: "A credit note must point at the invoice it reverses, and we must hold that invoice." },

  // tax
  TAX_PROVINCE_UNKNOWN: { severity: "warn", rule: "tax", why: "The province of delivery decides the tax; without it tax is not checked (never guessed)." },
  TAX_PROVINCE_MISMATCH: { severity: "block", rule: "tax", why: "The taxes charged are not the ones the province of delivery requires." },
  TAX_AMOUNT_MISMATCH: { severity: "block", rule: "tax", why: "The right tax is charged but at the wrong amount." },
  TAX_QST_COMPOUNDED: { severity: "block", rule: "tax", why: "QST was computed on subtotal + GST; it applies to the pre-tax amount only." },
  TAX_PST_ON_SERVICES: { severity: "block", rule: "tax", why: "BC PST applies to goods only, and it is not recoverable, so overcharged PST is lost money." },
  TAX_MISSING: { severity: "block", rule: "tax", why: "A GST-registered Canadian vendor charged no tax on a taxable supply." },
  TAX_ON_EXEMPT: { severity: "block", rule: "tax", why: "Tax was charged on an exempt supply (e.g. insurance premiums)." },
  TAX_FOREIGN_VENDOR: { severity: "warn", rule: "tax", why: "Foreign vendors normally charge no Canadian tax; a Canadian vendor should not use the foreign code." },
  TAX_CODE_UNKNOWN: { severity: "warn", rule: "tax", why: "A tax line could not be mapped to a known tax code, so it was not checked." },
  TAX_NUMBER_INVALID: { severity: "warn", rule: "tax", why: "The GST/HST or QST registration number is not in a valid format." },
  TAX_NUMBER_MISMATCH: { severity: "warn", rule: "tax", why: "The registration number on the invoice differs from the vendor master." },
  TAX_NUMBER_MISSING: { severity: "block", rule: "tax", why: "GST/HST was charged but neither the invoice nor the vendor master has a registration number: no input tax credit, classic fake-invoice sign." },
  QST_NUMBER_MISSING: { severity: "info", rule: "tax", why: "QST was charged without a QST registration number; the QST refund needs it on file." },
  VENDOR_NOT_TAX_REGISTERED: { severity: "info", rule: "tax", why: "The vendor has no GST number and charged no tax (small supplier); nothing to recover." },
  LINE_TYPE_UNKNOWN: { severity: "warn", rule: "tax", why: "A line is not marked goods or services, so BC PST could not be checked." },

  // vendor
  VENDOR_UNKNOWN: { severity: "warn", rule: "vendor", why: "Not in the vendor master; approvals holds it until the vendor is onboarded." },
  VENDOR_NOT_ACTIVE: { severity: "warn", rule: "vendor", why: "The vendor is pending review or on hold; approvals adds a check or holds the invoice." },
  VENDOR_LOOKALIKE: { severity: "warn", rule: "vendor", why: "This vendor record resembles a more established vendor (name, domain or bank account): possible impersonation." },
  VENDOR_NAME_MISMATCH: { severity: "info", rule: "vendor", why: "Matched by tax number or email domain, but the printed name differs from the vendor master." },

  // bank
  BANK_DETAILS_MISMATCH: { severity: "block", rule: "bank", why: "The remit-to account on the invoice is not the vendor's verified account." },
  BANK_ACCOUNT_UNVERIFIED: { severity: "block", rule: "bank", why: "The vendor's bank account was changed and the change was not verified by a second person." },
  BANK_RECENTLY_CHANGED: { severity: "warn", rule: "bank", why: "The vendor's bank account changed shortly before this invoice." },

  // purchase order
  PO_REQUIRED_MISSING: { severity: "warn", rule: "po", why: "The vendor requires a PO and none is given (policy P13); approvals holds it." },
  PO_NOT_FOUND: { severity: "block", rule: "po", why: "The PO number on the invoice does not exist." },
  PO_VENDOR_MISMATCH: { severity: "block", rule: "po", why: "The PO belongs to a different vendor." },
  PO_CLOSED: { severity: "block", rule: "po", why: "The PO is closed and cannot take more invoices." },
  PO_OVER_BALANCE: { severity: "warn", rule: "po", why: "The subtotal exceeds what is left on the PO (policy P12); approvals adds a finance-manager step." },
  PO_CURRENCY_MISMATCH: { severity: "warn", rule: "po", why: "The invoice and the PO are in different currencies." },
  PO_DEPT_MISMATCH: { severity: "info", rule: "po", why: "The PO was raised by a different department." },

  // contract
  CONTRACT_EXPIRED: { severity: "warn", rule: "contract", why: "The invoice date is after the vendor's contract ended." },
  CONTRACT_NOT_STARTED: { severity: "warn", rule: "contract", why: "The invoice date is before the vendor's contract started." },
  CONTRACT_FIXED_FEE_MISMATCH: { severity: "warn", rule: "contract", why: "A fixed-monthly contract billed a different amount than the agreed fee." },
  CONTRACT_FIXED_FEE_BILLED_TWICE: { severity: "warn", rule: "contract", why: "A fixed monthly fee was already billed for this month." },
  CONTRACT_USAGE_OVERAGE: { severity: "info", rule: "contract", why: "Charges on top of the fixed monthly fee." },
  CONTRACT_RATE_CAP_EXCEEDED: { severity: "block", rule: "contract", why: "An hourly rate is above the contract's cap." },
  CONTRACT_FUEL_SURCHARGE_CAP: { severity: "block", rule: "contract", why: "The fuel surcharge percentage is above the contract's cap." },
  CONTRACT_NTE_EXCEEDED: { severity: "warn", rule: "contract", why: "This month's spend under the contract passes its not-to-exceed amount." },
  CONTRACT_CURRENCY_MISMATCH: { severity: "warn", rule: "contract", why: "The invoice is in a different currency than the contract." },

  // dates
  DATE_IN_FUTURE: { severity: "warn", rule: "dates", why: "The invoice is dated after we received it." },
  DATE_TOO_OLD: { severity: "warn", rule: "dates", why: "The invoice is much older than when we received it (stale or resubmitted)." },
  DUE_BEFORE_INVOICE: { severity: "warn", rule: "dates", why: "The due date is before the invoice date." },
  TERMS_MISMATCH: { severity: "info", rule: "dates", why: "The due date does not follow the vendor's payment terms on file." },

  // fx
  FX_RATE_MISSING: { severity: "block", rule: "fx", why: "No USD→CAD rate near the invoice date, so CAD limits cannot be applied." },
  FX_RATE_MISMATCH: { severity: "warn", rule: "fx", why: "The FX rate stated on the invoice differs from the rate table." },

  // split
  SPLIT_INVOICE_SUSPECTED: { severity: "warn", rule: "split", why: "Several invoices from one vendor, each under an approval limit, add up to more than it; approvals routes on the combined total." },

  // engine
  VALIDATION_RULE_ERROR: { severity: "warn", rule: "engine", why: "A check could not run on this invoice; review it by hand." },
} as const satisfies Record<string, CodeInfo>;

export type FlagCode = keyof typeof FLAG_CODES;

export const ALL_FLAG_CODES = Object.keys(FLAG_CODES) as FlagCode[];
