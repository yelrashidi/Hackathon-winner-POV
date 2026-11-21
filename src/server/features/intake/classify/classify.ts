import type { DocumentReading } from "@/contracts/extraction";
import { IntakeClassification, type InboxAttachment, type InboxMessage } from "@/contracts/intake";
import type { LlmClassifier } from "./claude";
import { buildEmailText, type LlmVerdict } from "./prompt";
import { decideByRules, effectiveMime, inspect, type RuleContext, type RuleFindings } from "./rules";

/**
 * Intake classification of one email.
 *
 * Email WITH document attachments → each document is read on its own (extraction's
 * readDocument: text-layer rules, then one Claude read). Only documents that turn out to be
 * invoices or credit notes become draft bills. The email's wording never makes a bill.
 *
 * Email WITHOUT a readable document → rules.ts settles the clear cases; Claude reads the email
 * text for the rest; if Claude fails twice → needs_review. Never dropped.
 */

export interface DocumentToRead {
  sourceRef: string;
  filename: string;
  mime: string;
  bytes: Buffer;
}

export interface ClassifyDeps {
  ctx: RuleContext;
  /** Email-text classifier, used only for emails without documents. Absent → needs_review. */
  llm?: LlmClassifier;
  /** Fetches attachment bytes (Gmail API, dataset folder, upload store). */
  loadAttachment?: (msg: InboxMessage, attachment: InboxAttachment) => Promise<Buffer>;
  /** Extraction's service: reads one document and says whether it is a bill. */
  readDocument?: (doc: DocumentToRead) => Promise<DocumentReading>;
}

export interface IntakeResult {
  classification: IntakeClassification;
  /** Full readings, including extracted fields for bills — what step 3 persists. */
  readings: DocumentReading[];
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function readAll(msg: InboxMessage, f: RuleFindings, deps: Required<Pick<ClassifyDeps, "loadAttachment" | "readDocument">>) {
  const readings: DocumentReading[] = [];
  for (const doc of f.documents) {
    try {
      const bytes = await deps.loadAttachment(msg, doc);
      readings.push(await deps.readDocument({ sourceRef: doc.sourceRef, filename: doc.filename, mime: effectiveMime(doc), bytes }));
    } catch (err) {
      readings.push({ sourceRef: doc.sourceRef, filename: doc.filename, verdict: "uncertain", documentType: null,
        decidedBy: "fallback", textLayerChars: 0, signals: ["ATTACHMENT_UNREADABLE"], extracted: null, llmRaw: null,
        error: errorText(err), reason: `Could not open the attachment (${errorText(err)}) — a clerk should look at it.` });
    }
  }
  return readings;
}

const label = (r: DocumentReading) => (r.documentType ?? "unknown").replace(/_/g, " ");

/** Deterministic: the documents' verdicts decide the email. */
export function decideFromDocuments(f: RuleFindings, readings: DocumentReading[]): IntakeClassification {
  const bills = readings.filter((r) => r.verdict === "bill");
  const unsure = readings.filter((r) => r.verdict === "uncertain");
  const notBills = readings.filter((r) => r.verdict === "not_bill");
  const signals = [...f.signals, ...new Set(readings.flatMap((r) => r.signals))];
  if (unsure.length) signals.push("HAS_UNCERTAIN_DOCUMENT");
  const documents = readings.map(({ sourceRef, filename, verdict, documentType, reason }) => ({ sourceRef, filename, verdict, documentType, reason }));
  const decidedBy = readings.some((r) => r.decidedBy === "llm") ? "llm" : readings.some((r) => r.decidedBy === "fallback") ? "fallback" : "rules";
  const others = [...notBills, ...unsure].map((r) => `${r.filename} — ${r.verdict === "uncertain" ? "needs a person" : label(r)}`);
  const base = { documents, signals, decidedBy } as const;

  if (bills.length) {
    return { ...base, decision: "invoice", kind: "invoice", invoiceAttachments: bills.map((b) => b.sourceRef),
      reason: `${bills.length} of ${readings.length} attachment(s) ${bills.length === 1 ? "is a bill" : "are bills"}: `
        + bills.map((b) => `${b.filename} (${label(b)})`).join(", ")
        + (others.length ? `. Not drafted: ${others.join("; ")}.` : ".") };
  }
  if (unsure.length) {
    return { ...base, decision: "needs_review", kind: "other", invoiceAttachments: [],
      reason: `No attachment is clearly a bill: ${unsure.map((r) => `${r.filename} — ${r.reason}`).join(" ")}` };
  }

  // Every document was read and none is a bill.
  const types = new Set(notBills.map((r) => r.documentType));
  const why = `No bill among the attachments: ${notBills.map((r) => `${r.filename} — ${r.reason}`).join(" ")}`;
  const t = f.terms;
  if (types.has("statement") || t.STATEMENT_TERMS.length) return { ...base, decision: "needs_review", kind: "statement", invoiceAttachments: [], reason: why };
  if (t.INQUIRY_TERMS.length) return { ...base, decision: "needs_review", kind: "vendor_inquiry", invoiceAttachments: [], reason: why };
  if (types.has("quote") || types.has("purchase_order")) return { ...base, decision: "needs_review", kind: "other", invoiceAttachments: [], reason: why };
  if (types.has("receipt") || types.has("remittance_advice")) return { ...base, decision: "ignored", kind: "receipt", invoiceAttachments: [], reason: why };
  if (t.MARKETING_TERMS.length) return { ...base, decision: "ignored", kind: "marketing", invoiceAttachments: [], reason: why };
  if (f.knownVendor) return { ...base, decision: "needs_review", kind: "other", invoiceAttachments: [], reason: why };
  return { ...base, decision: "ignored", kind: "personal", invoiceAttachments: [], reason: `${why} Sender is not a known vendor.` };
}

/** Deterministic limits on what the email-text classifier may decide (no documents here). */
export function applyGuards(v: LlmVerdict, f: RuleFindings): IntakeClassification {
  const signals = [...f.signals, "LLM_DECIDED"];
  if (v.decision === "invoice") {
    return { decision: "needs_review", kind: "missing_attachment", decidedBy: "llm", signals: [...signals, "GUARD_NO_DOCUMENT"],
      invoiceAttachments: [], documents: [], reason: `Looks like an invoice email, but there is no readable document attached. ${v.reason}` };
  }
  return { decision: v.decision, kind: v.kind, decidedBy: "llm", signals, invoiceAttachments: [], documents: [], reason: v.reason };
}

export async function classifyEmail(msg: InboxMessage, deps: ClassifyDeps): Promise<IntakeResult> {
  const findings = inspect(msg, deps.ctx);

  if (findings.documents.length > 0) {
    if (!deps.loadAttachment || !deps.readDocument) {
      return { readings: [], classification: IntakeClassification.parse({ decision: "needs_review", kind: "other", decidedBy: "fallback",
        signals: [...findings.signals, "DOCUMENT_READER_NOT_CONFIGURED"],
        reason: `Has ${findings.documents.length} document attachment(s) but no document reader is configured — a clerk should look at it.` }) };
    }
    const readings = await readAll(msg, findings, { loadAttachment: deps.loadAttachment, readDocument: deps.readDocument });
    return { readings, classification: IntakeClassification.parse(decideFromDocuments(findings, readings)) };
  }

  const byRules = decideByRules(findings);
  if (byRules) return { readings: [], classification: IntakeClassification.parse(byRules) };

  if (!deps.llm) {
    return { readings: [], classification: IntakeClassification.parse({ decision: "needs_review", kind: "other", decidedBy: "fallback",
      signals: [...findings.signals, "LLM_NOT_CONFIGURED"],
      reason: "Rules could not decide and no classifier model is configured — a clerk should look at it." }) };
  }

  const input = { text: buildEmailText(msg, findings) };
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return { readings: [], classification: IntakeClassification.parse(applyGuards(await deps.llm(input), findings)) };
    } catch (err) {
      lastError = errorText(err);
    }
  }
  return { readings: [], classification: IntakeClassification.parse({ decision: "needs_review", kind: "other", decidedBy: "fallback",
    signals: [...findings.signals, "LLM_FAILED"],
    reason: `Rules could not decide and the classifier failed twice (${lastError}) — a clerk should look at it.` }) };
}
