import "server-only";

// TEMP: the one place the upload screen calls extraction (feature 2). Nobody has built
// extraction yet, so this always answers "unavailable" and every file opens for manual entry;
// nothing is guessed. When the extraction owner's code lands, call it here and map its output
// onto ExtractedFields. The upload screen doesn't change.

/** What the form can be prefilled with. Keys match the upload form's fields. */
export type ExtractedFields = Partial<{
  vendorName: string;
  invoiceNumber: string;
  invoiceDate: string; // YYYY-MM-DD
  dueDate: string; // YYYY-MM-DD
  currency: string;
  poNumber: string;
  shipToProvince: string;
  lines: { description: string; quantity: string; unitPrice: string; amount: string }[];
  taxes: { code: string; amount: string }[];
  subtotal: string;
  total: string;
}>;

export type ExtractionResult =
  | {
      status: "ok";
      fields: ExtractedFields;
      /** 0..1 per field key; below the "Check this" threshold the field is marked. */
      confidence: Partial<Record<keyof ExtractedFields, number>>;
    }
  | { status: "failed"; reason: string }
  | { status: "unavailable" };

export async function extractInvoice(file: File): Promise<ExtractionResult> {
  void file; // read by the real extraction, once it exists
  return { status: "unavailable" };
}
