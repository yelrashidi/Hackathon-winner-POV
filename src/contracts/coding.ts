import { z } from "zod";
import { Flag } from "./flag";

/**
 * Feature 3 — smart coding. Puts every invoice line in a GL account and a department, with the
 * reason, for a person to accept or change; then previews the journal entry the coding produces.
 *
 * Input: the extracted invoice (`ValidationInput`, src/contracts/validation.ts — extraction's
 * output) plus the vendor id validation's `matchVendor` resolved, so coding, validation and
 * duplicates agree on the vendor. Output: `CodingResult`, persisted to `invoice_lines`
 * (gl_account_code, department_id, coding_source, coding_reason jsonb).
 * Rules for changing this file: docs/rules/contracts.md.
 */

const Cents = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);

/**
 * high   — strong, consistent evidence (e.g. 12 of the last 12 lines); safe to bulk-accept
 * medium — one good source, or some disagreement; a person should glance at it
 * low    — a guess from weak or split evidence; a person must decide
 * none   — no basis; must be coded by hand
 */
export const CodingConfidence = z.enum(["high", "medium", "low", "none"]);
export type CodingConfidence = z.infer<typeof CodingConfidence>;

/** Where an account suggestion came from, strongest first. */
export const AccountBasis = z.enum([
  "credit_note_original", // a credit note is coded like the invoice it reverses
  "discount_parent", // a discount line reduces the cost of the line it applies to
  "recent_correction", // a person recently re-coded this vendor's lines like this one
  "vendor_description", // this vendor's past lines with a similar description
  "vendor_history", // this vendor's recent lines
  "vendor_default", // the vendor master's default account (no usable history)
  "category", // what other vendors in the same category are coded to
  "description_similarity", // similar lines at other vendors (unknown vendor)
  "none",
]);
export type AccountBasis = z.infer<typeof AccountBasis>;

/** Where a department suggestion came from, strongest first. */
export const DepartmentBasis = z.enum([
  "invoice", // the invoice is already assigned to a department (intake / the submitter)
  "requester", // the requester's own department
  "purchase_order", // the PO the invoice references
  "credit_note_original",
  "discount_parent",
  "open_purchase_order", // the vendor's only open PO (not referenced on the invoice)
  "vendor_description",
  "vendor_history",
  "none",
]);
export type DepartmentBasis = z.infer<typeof DepartmentBasis>;

export const CodingAlternative = z.object({
  value: z.string(),
  label: z.string(),
  /** How many past lines (or how much evidence) point at it. */
  count: z.number().int().nonnegative(),
});
export type CodingAlternative = z.infer<typeof CodingAlternative>;

const suggestion = <B extends z.ZodTypeAny>(basis: B) =>
  z.object({
    /** GL account number or department id; null = no suggestion. */
    value: z.string().nullable(),
    /** "5010 Freight & Carrier Costs" / "Operations (D01)". */
    label: z.string().nullable(),
    confidence: CodingConfidence,
    basis,
    /** One sentence with the numbers: "12 of the last 12 Polar Freight Lines Ltd. lines → 5010 Freight & Carrier Costs". */
    reason: z.string(),
    /** Other values the evidence points at, most likely first. */
    alternatives: z.array(CodingAlternative),
  });

export const AccountSuggestion = suggestion(AccountBasis);
export type AccountSuggestion = z.infer<typeof AccountSuggestion>;
export const DepartmentSuggestion = suggestion(DepartmentBasis);
export type DepartmentSuggestion = z.infer<typeof DepartmentSuggestion>;

/** suggested = nobody has looked yet · accepted = a person confirmed the suggestion · changed = a person chose something else. */
export const CodingSource = z.enum(["suggested", "accepted", "changed"]);
export type CodingSource = z.infer<typeof CodingSource>;

/** One invoice line's coding: what was suggested, and what will be posted. */
export const LineCoding = z.object({
  lineNo: z.number().int().positive(),
  description: z.string(),
  quantity: z.number().finite(),
  unitPriceCents: Cents,
  amountCents: Cents,
  /** goods | services | null (unknown): non-recoverable BC PST is spread over goods lines only. */
  lineType: z.enum(["goods", "services"]).nullable(),
  account: AccountSuggestion,
  department: DepartmentSuggestion,
  /** What will be posted: the suggestion until a person accepts or changes it. */
  glAccount: z.string().nullable(),
  departmentId: z.string().nullable(),
  source: CodingSource,
  codedBy: z.string().nullable(),
  codedAt: z.string().nullable(),
  /** Why a person changed the suggestion (required when overriding a high-confidence one). */
  note: z.string().nullable(),
});
export type LineCoding = z.infer<typeof LineCoding>;

export const JournalEntryKind = z.enum(["line", "recoverable_tax", "non_recoverable_tax", "unallocated_tax"]);
export type JournalEntryKind = z.infer<typeof JournalEntryKind>;

/** One debit of the journal entry. Signed: a credit note's debits are negative. */
export const JournalEntry = z.object({
  /** null = not coded yet, or a tax that could not be placed. */
  glAccount: z.string().nullable(),
  departmentId: z.string().nullable(),
  amountCents: Cents,
  kind: JournalEntryKind,
  lineNo: z.number().int().positive().nullable(),
  taxCode: z.string().nullable(),
});
export type JournalEntry = z.infer<typeof JournalEntry>;

/**
 * The entry the coding would post: debit each line's account (plus its share of any tax the
 * company cannot recover, e.g. BC PST), debit recoverable GST/HST/QST to their receivable
 * accounts, credit Accounts Payable for the invoice total. In invoice currency.
 */
export const JournalPreview = z.object({
  currency: z.string().nullable(),
  debits: z.array(JournalEntry),
  credit: z.object({ glAccount: z.string().nullable(), amountCents: Cents }),
  balanced: z.boolean(),
  /** credit − Σ debits. */
  differenceCents: Cents,
});
export type JournalPreview = z.infer<typeof JournalPreview>;

export const CodingResult = z.object({
  invoiceId: z.string(),
  vendorId: z.string().nullable(),
  /** For invoices.department_id when intake did not set it (approvals routes on it). */
  invoiceDepartment: DepartmentSuggestion,
  lines: z.array(LineCoding),
  journal: JournalPreview,
  /** Coding findings in the shared flag shape (CODING_* codes). */
  flags: z.array(Flag),
});
export type CodingResult = z.infer<typeof CodingResult>;
