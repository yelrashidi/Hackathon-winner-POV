import "server-only";

// The one place the upload screen calls extraction (feature 2, Arpan). The file is read by the real
// reader (readDocument: PDF text layer → rules → one Claude read), then its fields are mapped onto the
// upload form. Without ANTHROPIC_API_KEY there is no model, so every file opens for manual entry —
// nothing is guessed. The person always checks the form against the original before confirming.

import type { ExtractedDocument } from "@/contracts/extraction";
import { createClaudeExtractor } from "@/server/features/extraction/claude";
import { readDocument } from "@/server/features/extraction/read-document";
import { taxCodesFromCsv } from "@/server/features/extraction/tax-codes";
import { centsToInput } from "../../../_lib/format";

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
      warnings: string[];
      documentType: string;
    }
  | { status: "failed"; reason: string }
  | { status: "not_a_bill"; reason: string }
  | { status: "unavailable" };

/** Extraction's confidence keys → the form's field keys. */
const CONFIDENCE_FOR: Record<keyof ExtractedFields, string[]> = {
  vendorName: ["vendor", "vendor.nameRaw", "vendorName"],
  invoiceNumber: ["invoiceNumber"],
  invoiceDate: ["invoiceDate"],
  dueDate: ["dueDate"],
  currency: ["currency"],
  poNumber: ["poNumber"],
  shipToProvince: ["shipToProvince"],
  lines: ["lines"],
  taxes: ["taxes"],
  subtotal: ["subtotalCents", "subtotal"],
  total: ["totalCents", "total"],
};

function toFields(x: ExtractedDocument): { fields: ExtractedFields; confidence: Partial<Record<keyof ExtractedFields, number>> } {
  const fields: ExtractedFields = {
    vendorName: x.vendor.nameRaw ?? "",
    invoiceNumber: x.invoiceNumber ?? "",
    invoiceDate: x.invoiceDate ?? "",
    dueDate: x.dueDate ?? "",
    currency: x.currency ?? "",
    poNumber: x.poNumber ?? "",
    shipToProvince: x.shipToProvince ?? "",
    lines: x.lines.map((l) => ({ description: l.description, quantity: String(l.quantity), unitPrice: centsToInput(l.unitPriceCents), amount: centsToInput(l.amountCents) })),
    taxes: x.taxes.map((t) => ({ code: t.code ?? "", amount: centsToInput(t.amountCents) })),
    subtotal: centsToInput(x.subtotalCents),
    total: centsToInput(x.totalCents),
  };
  const confidence: Partial<Record<keyof ExtractedFields, number>> = {};
  for (const [field, keys] of Object.entries(CONFIDENCE_FOR) as [keyof ExtractedFields, string[]][]) {
    const found = keys.map((k) => x.confidence[k]).find((v) => typeof v === "number");
    if (found !== undefined) confidence[field] = found;
  }
  return { fields, confidence };
}

export async function extractInvoice(file: { bytes: Buffer; name: string; type: string }): Promise<ExtractionResult> {
  if (!process.env.ANTHROPIC_API_KEY) return { status: "unavailable" };
  const reading = await readDocument({ sourceRef: file.name, filename: file.name, mime: file.type, bytes: file.bytes }, { llm: createClaudeExtractor(taxCodesFromCsv()) });
  if (reading.verdict === "not_bill") return { status: "not_a_bill", reason: reading.reason };
  if (!reading.extracted) return { status: "failed", reason: reading.reason };
  return { status: "ok", ...toFields(reading.extracted), warnings: reading.extracted.warnings, documentType: reading.extracted.documentType };
}
