import { z } from "zod";

/**
 * Feature 4 — validation. `ValidationInput` is one invoice as the extraction stage (2) hands it
 * over, after a clean read (or after manual entry). Validation turns it into `Flag[]`
 * (`src/contracts/flag.ts`).
 *
 * Until extraction publishes its own contract, this is our assumption of its output. When it
 * lands, one mapper turns extraction's shape into this one; the rules never change.
 * Rules for changing this file: docs/rules/contracts.md.
 *
 * Money is integer cents in the invoice currency, signed (credit notes are negative).
 * Dates are ISO `YYYY-MM-DD`. Rates and quantities are plain decimals.
 */

/**
 * YYYY-MM-DD in shape. Whether it is a real calendar day (2026-02-30 is not) is checked by
 * validation itself, which raises INVALID_DATE instead of throwing, so a misread date never
 * crashes the pipeline and never shifts silently to another day.
 */
export const IsoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
export type IsoDate = z.infer<typeof IsoDate>;

const Cents = z.number().int();
/** Extraction often emits "" or "  " for a field it could not read: that means missing, never an error. */
const blankToNull = (s: string | null): string | null => (s === null || s.trim() === "" ? null : s.trim());
const nullableString = z.string().nullable().transform(blankToNull).default(null);
/** An optional date: "" → null, otherwise YYYY-MM-DD in shape. */
const optionalIsoDate = z.string().nullable().transform(blankToNull).pipe(IsoDate.nullable()).default(null);

export const LineType = z.enum(["goods", "services"]);
export type LineType = z.infer<typeof LineType>;

export const ValidationLine = z.object({
  lineNo: z.number().int().positive(),
  description: z.string(),
  /** Decimal; hours can be fractional (2.5). */
  quantity: z.number().finite(),
  unitPriceCents: Cents,
  amountCents: Cents,
  /** BC PST applies to goods only. null = extraction could not tell. */
  lineType: LineType.nullable().default(null),
});
export type ValidationLine = z.infer<typeof ValidationLine>;

export const ValidationTax = z.object({
  /** A `tax_codes.code` (HST13, GST5, PST7_BC, QST9975, EXEMPT, FOREIGN) as extraction mapped it; null if unmapped. */
  code: z.string().nullable().transform(blankToNull),
  /** As printed: "QST (9.975%)", "TVQ (9,975 %)". */
  label: z.string(),
  /** As printed, if any: 9.975. Informational; the rate used for checking comes from tax_codes. */
  ratePct: z.number().nullable().default(null),
  amountCents: Cents,
});
export type ValidationTax = z.infer<typeof ValidationTax>;

export const RemitTo = z.object({
  institution: nullableString,
  transit: nullableString,
  account: nullableString,
});
export type RemitTo = z.infer<typeof RemitTo>;

export const ValidationInput = z.object({
  invoiceId: z.string().min(1),
  documentType: z.enum(["invoice", "credit_note"]).default("invoice"),

  vendor: z.object({
    nameRaw: nullableString,
    gstHstNumber: nullableString,
    qstNumber: nullableString,
    /** Province/state code from the vendor's printed address (ON, BC, WA, TX…). */
    province: nullableString,
    /** ISO country code if known (CA, US). */
    country: nullableString,
  }),
  /** Sender of the email the invoice came in (intake). null for uploads. */
  senderEmail: nullableString,

  invoiceNumber: nullableString,
  invoiceDate: optionalIsoDate,
  dueDate: optionalIsoDate,
  /** When we received it (email received_at or upload time). Always known. */
  receivedDate: IsoDate,
  currency: nullableString,
  /** Printed terms in days ("Net 30" → 30, "Due on receipt" → 0). */
  paymentTermsDays: z.number().int().nonnegative().nullable().default(null),

  poNumber: nullableString,
  contractRef: nullableString,
  /** For credit notes: the invoice number it reverses, as printed. */
  creditNoteRef: nullableString,

  billTo: z
    .object({
      name: nullableString,
      address: nullableString,
      province: nullableString,
    })
    .default({ name: null, address: null, province: null }),
  /** Province of delivery if the document states it separately from the bill-to. */
  shipToProvince: nullableString,

  lines: z.array(ValidationLine).default([]),
  taxes: z.array(ValidationTax).default([]),
  subtotalCents: Cents.nullable().default(null),
  totalCents: Cents.nullable().default(null),
  /** Only if the document states an FX rate. */
  statedFxRate: z.number().positive().nullable().default(null),

  remitTo: RemitTo.nullable().default(null),

  departmentId: nullableString,
  requesterId: nullableString,

  /** Per-field extraction confidence 0..1, keyed by field name (e.g. totalCents, invoiceDate). */
  confidence: z.record(z.string(), z.number().min(0).max(1)).default({}),
});
/** What a producer writes (defaults optional). */
export type ValidationInputDraft = z.input<typeof ValidationInput>;
/** What the rules read (defaults applied). */
export type ValidationInput = z.output<typeof ValidationInput>;
