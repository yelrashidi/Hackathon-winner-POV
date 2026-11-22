import path from "node:path";
import { DocumentReading, ExtractedDocument } from "@/contracts/extraction";
import type { DocumentToRead } from "@/server/features/intake/classify/classify";
import { loadIncomingFixtures, type IncomingFixture } from "@/server/features/validation/dataset/batch";

/**
 * Demo only: extraction's answer for the dataset's 56 incoming documents WITHOUT calling Claude.
 *
 * fixtures/validation/incoming/ holds one frozen reading per incoming PDF/scan (the fields
 * extraction hands to validation). This reader looks a document up by file name and returns that
 * reading as a DocumentReading, so the demo database fills through the real intake → pipeline
 * path (ingestFromIntake) offline, for free, and the same on every start.
 *
 * A document with no frozen reading comes back as a bill with no fields → manual entry, the same
 * answer real extraction gives when the model is unavailable. Never a guess.
 */

export const FROZEN_SIGNAL = "FROZEN_READING";

function byFileName(): Map<string, IncomingFixture> {
  const out = new Map<string, IncomingFixture>();
  for (const { fixture } of loadIncomingFixtures()) out.set(path.basename(fixture.source), fixture);
  return out;
}

/** The ExtractedDocument part of a frozen ValidationInput (the intake facts are added back by readingToValidationInput). */
function toExtracted(f: IncomingFixture): ExtractedDocument {
  const i = f.input;
  return ExtractedDocument.parse({
    documentType: i.documentType === "credit_note" ? "credit_note" : "invoice",
    documentTypeReason: "Frozen reading of this file (fixtures/validation/incoming).",
    language: null,
    vendor: {
      nameRaw: i.vendor?.nameRaw ?? null,
      gstHstNumber: i.vendor?.gstHstNumber ?? null,
      qstNumber: i.vendor?.qstNumber ?? null,
      address: null,
      province: i.vendor?.province ?? null,
      country: i.vendor?.country ?? null,
    },
    invoiceNumber: i.invoiceNumber ?? null,
    invoiceDate: i.invoiceDate ?? null,
    dueDate: i.dueDate ?? null,
    currency: i.currency ?? null,
    paymentTermsDays: i.paymentTermsDays ?? null,
    poNumber: i.poNumber ?? null,
    contractRef: i.contractRef ?? null,
    creditNoteRef: i.creditNoteRef ?? null,
    billTo: i.billTo ?? undefined,
    shipToProvince: i.shipToProvince ?? null,
    lines: i.lines ?? [],
    taxes: i.taxes ?? [],
    subtotalCents: i.subtotalCents ?? null,
    totalCents: i.totalCents ?? null,
    statedFxRate: i.statedFxRate ?? null,
    remitTo: i.remitTo ?? null,
    confidence: i.confidence ?? {},
    warnings: [],
  });
}

/** A readDocument() for classifyEmail that answers from the frozen readings. */
export function createFrozenReader(): (doc: DocumentToRead) => Promise<DocumentReading> {
  const fixtures = byFileName();
  return async (doc) => {
    const base = { sourceRef: doc.sourceRef, filename: doc.filename, llmRaw: null, error: null, textLayerChars: 0 };
    const f = fixtures.get(doc.filename);
    if (!f) {
      return DocumentReading.parse({
        ...base,
        verdict: "bill",
        documentType: null,
        decidedBy: "fallback",
        signals: [FROZEN_SIGNAL, "EXTRACTION_FAILED"],
        extracted: null,
        error: "no frozen reading for this file",
        reason: "No frozen reading for this file and no extraction model in the demo — manual entry.",
      });
    }
    const extracted = toExtracted(f);
    return DocumentReading.parse({
      ...base,
      verdict: "bill",
      documentType: extracted.documentType,
      decidedBy: "llm",
      signals: [FROZEN_SIGNAL, "LLM_BILL"],
      extracted,
      reason: `${extracted.documentType === "credit_note" ? "Credit note" : "Invoice"} (frozen reading, no API call).`,
    });
  };
}
