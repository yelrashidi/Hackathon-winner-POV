import { BILL_DOCUMENT_TYPES, DocumentReading, type DocumentType } from "@/contracts/extraction";
import { EXTRACTOR_IMAGE_MIME, type ExtractorInput, type LlmExtractor } from "./claude";
import { classifyDocumentText, type DocTypeRuleResult } from "./doc-type-rules";
import { normalizeExtraction } from "./normalize";
import { hasUsableText, readPdfTextLayer } from "./pdf-text";

/**
 * One attachment → one DocumentReading. In order:
 *   1. PDF text layer, locally.
 *   2. doc-type-rules.ts on that text. Only a clear "not a bill" stops here (no model call).
 *   3. Claude reads it once: document type + all fields (text if there is a text layer, else
 *      the PDF/image itself).
 *   4. Deterministic verdict:
 *        model says invoice/credit note                  → bill
 *        model says not a bill, rules said bill_likely   → uncertain (clerk decides)
 *        model says not a bill                            → not_bill
 *        model failed, rules said bill_likely            → bill with no fields (manual entry)
 *        model failed, rules unsure                       → uncertain
 */

export interface DocumentInput {
  sourceRef: string;
  filename: string;
  mime: string;
  bytes: Buffer;
}

export interface ReadDocumentDeps {
  /** Absent → no model configured: text rules only; bills land in manual entry. */
  llm?: LlmExtractor;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function readDocument(doc: DocumentInput, deps: ReadDocumentDeps): Promise<DocumentReading> {
  const base = { sourceRef: doc.sourceRef, filename: doc.filename, llmRaw: null, error: null, extracted: null };
  const signals: string[] = [];

  // 1. Text layer
  const layer = doc.mime === "application/pdf" ? await readPdfTextLayer(doc.bytes) : null;
  const usable = hasUsableText(layer);
  const textLayerChars = usable ? layer.text.length : 0;
  signals.push(usable ? "DOC_TEXT_LAYER" : "DOC_NO_TEXT_LAYER");

  // 2. Rules on the document's own text
  const rules: DocTypeRuleResult = usable
    ? classifyDocumentText(layer.text)
    : { verdict: "unknown", documentType: null, signals: [], reason: "No text layer (scan or image) — must be read visually." };
  signals.push(...rules.signals);

  if (rules.verdict === "not_bill") {
    return DocumentReading.parse({ ...base, verdict: "not_bill", documentType: rules.documentType, decidedBy: "rules",
      textLayerChars, signals, reason: rules.reason });
  }

  // 3. Claude reads it
  let input: ExtractorInput | null = null;
  if (usable) input = { kind: "text", text: layer.text, filename: doc.filename };
  else if (doc.mime === "application/pdf") input = { kind: "pdf", base64: doc.bytes.toString("base64"), filename: doc.filename };
  else if (EXTRACTOR_IMAGE_MIME.has(doc.mime)) {
    input = { kind: "image", base64: doc.bytes.toString("base64"), mime: doc.mime as "image/png", filename: doc.filename };
  }

  const fallback = (why: string): DocumentReading => {
    const sig = [...signals, "EXTRACTION_FAILED"];
    if (rules.verdict === "bill_likely") {
      return DocumentReading.parse({ ...base, verdict: "bill", documentType: rules.documentType, decidedBy: "fallback",
        textLayerChars, signals: sig, error: why,
        reason: `${rules.reason} Fields could not be read automatically (${why}) — manual entry.` });
    }
    return DocumentReading.parse({ ...base, verdict: "uncertain", documentType: null, decidedBy: "fallback",
      textLayerChars, signals: sig, error: why, reason: `Could not tell what this document is (${why}) — a clerk should look at it.` });
  };

  if (!deps.llm) return fallback("no extraction model configured");
  if (!input) return fallback(`format ${doc.mime} cannot be read automatically`);

  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await deps.llm(input);
      const extracted = normalizeExtraction(raw);
      const type: DocumentType = extracted.documentType;
      const isBill = BILL_DOCUMENT_TYPES.has(type);
      const common = { ...base, llmRaw: raw, textLayerChars, documentType: type, decidedBy: "llm" as const };

      // 4. Verdict
      if (isBill) {
        return DocumentReading.parse({ ...common, verdict: "bill", extracted, signals: [...signals, "LLM_BILL"],
          reason: `${type === "credit_note" ? "Credit note" : "Invoice"}: ${extracted.documentTypeReason}` });
      }
      if (rules.verdict === "bill_likely") {
        return DocumentReading.parse({ ...common, verdict: "uncertain", extracted, signals: [...signals, "RULES_MODEL_DISAGREE"],
          reason: `Text rules say ${rules.documentType} (${rules.reason}) but the model says ${type} (${extracted.documentTypeReason}) — a clerk should decide.` });
      }
      return DocumentReading.parse({ ...common, verdict: "not_bill", extracted: null, signals: [...signals, "LLM_NOT_BILL"],
        reason: `Not a bill (${type.replace(/_/g, " ")}): ${extracted.documentTypeReason}` });
    } catch (err) {
      lastError = errorText(err);
    }
  }
  return fallback(`model failed twice: ${lastError}`);
}
