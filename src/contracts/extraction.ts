import { z } from "zod";
import { IsoDate, RemitTo, ValidationLine, ValidationTax } from "./validation";

/**
 * Feature 2 — extraction. One read of one document (PDF or image) answers two questions:
 *   1. what kind of document is it (only invoices and credit notes become bills), and
 *   2. if it is a bill, what does it say (vendor, number, dates, lines, taxes, totals).
 *
 * Field names match `ValidationInput` (src/contracts/validation.ts) so validation's mapper is a
 * copy plus the intake facts (invoiceId, senderEmail, receivedDate). Lines, taxes and remit-to
 * reuse validation's schemas: one shape, not two that drift.
 *
 * Money is integer cents in the document currency, signed (credit notes negative). The model
 * returns amounts as printed; deterministic code converts them (docs/rules/money-and-tax.md).
 * Rules for changing this file: docs/rules/contracts.md.
 */

const blankToNull = (s: string | null): string | null => (s === null || s.trim() === "" ? null : s.trim());
const nullableString = z.string().nullable().transform(blankToNull).default(null);
const optionalIsoDate = z.string().nullable().transform(blankToNull).pipe(IsoDate.nullable()).default(null);
const Cents = z.number().int();

export const DocumentType = z.enum([
  "invoice", "credit_note",                    // → draft bill
  "receipt", "statement", "quote", "purchase_order", "remittance_advice", "other", // → not a bill
]);
export type DocumentType = z.infer<typeof DocumentType>;
export const BILL_DOCUMENT_TYPES: ReadonlySet<DocumentType> = new Set(["invoice", "credit_note"]);

export const ExtractedDocument = z.object({
  documentType: DocumentType,
  /** Why this type, citing the document ("Titled CREDIT NOTE; negative amounts"). */
  documentTypeReason: z.string(),
  language: nullableString,

  vendor: z.object({
    nameRaw: nullableString,
    gstHstNumber: nullableString,
    qstNumber: nullableString,
    address: nullableString,
    province: nullableString,
    country: nullableString,
  }),
  invoiceNumber: nullableString,
  invoiceDate: optionalIsoDate,
  dueDate: optionalIsoDate,
  currency: nullableString,
  paymentTermsDays: z.number().int().nonnegative().nullable().default(null),
  poNumber: nullableString,
  contractRef: nullableString,
  creditNoteRef: nullableString,
  billTo: z.object({ name: nullableString, address: nullableString, province: nullableString })
    .default({ name: null, address: null, province: null }),
  shipToProvince: nullableString,

  lines: z.array(ValidationLine).default([]),
  taxes: z.array(ValidationTax).default([]),
  subtotalCents: Cents.nullable().default(null),
  totalCents: Cents.nullable().default(null),
  statedFxRate: z.number().positive().nullable().default(null),
  remitTo: RemitTo.nullable().default(null),

  /** Per-field confidence 0..1 (keys as in ValidationInput.confidence). */
  confidence: z.record(z.string(), z.number().min(0).max(1)).default({}),
  /** Things the normalizer fixed or could not read ("total '12,3O' unreadable"). Shown to the clerk. */
  warnings: z.array(z.string()).default([]),
});
export type ExtractedDocument = z.infer<typeof ExtractedDocument>;
export type ExtractedDocumentInput = z.input<typeof ExtractedDocument>;

/**
 * The verdict on one attachment, which intake turns into a draft bill (or not).
 * - `bill`       → draft bill; `extracted` may be null if reading failed (→ manual entry, never a guess)
 * - `not_bill`   → kept on the email with its reason, no bill
 * - `uncertain`  → clerk decides (rules and model disagree, or nothing could read it)
 */
export const DocumentReading = z.object({
  sourceRef: z.string(),
  filename: z.string(),
  verdict: z.enum(["bill", "not_bill", "uncertain"]),
  documentType: DocumentType.nullable(),
  reason: z.string().min(1),
  decidedBy: z.enum(["rules", "llm", "fallback"]),
  /** Characters in the PDF text layer; 0 for images and scans. */
  textLayerChars: z.number().int().nonnegative(),
  signals: z.array(z.string()).default([]),
  extracted: ExtractedDocument.nullable(),
  /** The model's raw structured reply, kept for debugging and re-parsing without a new call. */
  llmRaw: z.unknown().nullable().default(null),
  error: nullableString,
});
export type DocumentReading = z.infer<typeof DocumentReading>;
