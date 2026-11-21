import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { DocumentReading } from "@/contracts/extraction";
import { InboxMessage, type InboxMessageInput } from "@/contracts/intake";
import { readDocument } from "@/server/features/extraction/read-document";
import { classifyEmail, type ClassifyDeps } from "../classify/classify";
import type { LlmClassifier } from "../classify/claude";
import { decideByRules, inspect, matchTerms } from "../classify/rules";
import { fromDatasetFile } from "../dataset/emails";
import { DATASET_DIR, vendorDomainsFromCsv } from "../dataset/vendors";

const ctx = { knownVendorDomains: new Set(["vendor.example"]) };
const pdf = (filename = "doc.pdf", sourceRef = filename) => ({ filename, mimeType: "application/pdf", sizeBytes: 50_000, sourceRef });

function email(over: Partial<InboxMessageInput>): InboxMessage {
  return InboxMessage.parse({
    source: "gmail", externalId: "m1", fromAddress: "ar@vendor.example", subject: "",
    receivedAt: "2026-11-21T10:00:00Z", bodyText: "", attachments: [], ...over,
  });
}
const rules = (m: InboxMessage) => decideByRules(inspect(m, ctx));

/** A fake document reader: verdict per sourceRef. */
function reader(verdicts: Record<string, Pick<DocumentReading, "verdict" | "documentType">>): ClassifyDeps["readDocument"] {
  return async (d) => ({
    sourceRef: d.sourceRef, filename: d.filename, ...verdicts[d.sourceRef]!, reason: `fake: ${verdicts[d.sourceRef]!.documentType}`,
    decidedBy: "llm", textLayerChars: 100, signals: [], extracted: null, llmRaw: null, error: null,
  });
}
const load = async () => Buffer.from("x");

describe("email rules (no readable document)", () => {
  it("never decides an email that has a document — documents are read instead", () => {
    expect(rules(email({ subject: "Facture 12", attachments: [pdf()] }))).toBeNull();
  });

  it("reads French with accents and payment terms that mention receipt", () => {
    expect(matchTerms("Note de crédit — payable on receipt").INVOICE_TERMS).toContain("note de credit");
    expect(matchTerms("Payment due upon receipt").RECEIPT_TERMS).toEqual([]);
    expect(matchTerms("Votre reçu").RECEIPT_TERMS).toContain("recu");
    expect(matchTerms("20% off all chairs").MARKETING_TERMS).toContain("% off");
  });

  it("does not treat words inside other words as matches", () => {
    expect(matchTerms("Invitation to our event").INVOICE_TERMS).toEqual([]);
    expect(matchTerms("wholesale pricing").MARKETING_TERMS).toEqual([]);
  });

  it("routes an invoice mention without attachment to review", () => {
    expect(rules(email({ subject: "Invoice attached" }))).toMatchObject({ decision: "needs_review", kind: "missing_attachment" });
  });

  it("treats a tiny logo as no attachment", () => {
    const d = rules(email({ subject: "Invoice 9", attachments: [{ filename: "logo.png", mimeType: "image/png", sizeBytes: 900, sourceRef: "x" }] }));
    expect(d).toMatchObject({ decision: "needs_review", kind: "missing_attachment" });
    expect(d?.signals).toContain("ATTACHMENT_SMALL_IMAGE_SKIPPED");
  });

  it.each([
    ["Where is my payment for invoice 4?", "needs_review", "vendor_inquiry"],
    ["Statement of account - October", "needs_review", "statement"],
    ["Thank you for your payment", "ignored", "receipt"],
    ["Big sale this weekend — unsubscribe below", "ignored", "marketing"],
  ])("no attachment: %s → %s/%s", (subject, decision, kind) => {
    expect(rules(email({ subject }))).toMatchObject({ decision, kind });
  });

  it("ignores personal mail from an unknown sender without calling Claude", () => {
    expect(rules(email({ fromAddress: "friend@gmail.com", subject: "Dinner Saturday?" })))
      .toMatchObject({ decision: "ignored", kind: "personal" });
  });

  it("sends a known vendor without keywords to Claude", () => {
    expect(rules(email({ subject: "Following up" }))).toBeNull();
  });
});

describe("emails with documents: only bills become draft bills", () => {
  it("drafts a bill only for the attachment that is an invoice, whatever the email says", async () => {
    const m = email({ subject: "Invoice 42 attached", attachments: [pdf("inv.pdf"), pdf("terms.pdf"), pdf("brochure.pdf")] });
    const { classification: c } = await classifyEmail(m, { ctx, loadAttachment: load, readDocument: reader({
      "inv.pdf": { verdict: "bill", documentType: "invoice" },
      "terms.pdf": { verdict: "not_bill", documentType: "other" },
      "brochure.pdf": { verdict: "not_bill", documentType: "other" },
    }) });
    expect(c).toMatchObject({ decision: "invoice", invoiceAttachments: ["inv.pdf"] });
    expect(c.reason).toContain("1 of 3");
    expect(c.documents.map((d) => d.verdict)).toEqual(["bill", "not_bill", "not_bill"]);
  });

  it("drafts nothing when 'Invoice attached' carries a non-invoice PDF", async () => {
    const m = email({ subject: "Invoice attached", attachments: [pdf("menu.pdf")] });
    const { classification: c } = await classifyEmail(m, { ctx, loadAttachment: load, readDocument: reader({ "menu.pdf": { verdict: "not_bill", documentType: "other" } }) });
    expect(c.decision).not.toBe("invoice");
    expect(c.invoiceAttachments).toEqual([]);
  });

  it("ignores a receipt PDF", async () => {
    const m = email({ subject: "Your receipt", attachments: [pdf("r.pdf")] });
    const { classification: c } = await classifyEmail(m, { ctx, loadAttachment: load, readDocument: reader({ "r.pdf": { verdict: "not_bill", documentType: "receipt" } }) });
    expect(c).toMatchObject({ decision: "ignored", kind: "receipt" });
  });

  it("sends an uncertain document to a person", async () => {
    const m = email({ subject: "Docs", attachments: [pdf("x.pdf")] });
    const { classification: c } = await classifyEmail(m, { ctx, loadAttachment: load, readDocument: reader({ "x.pdf": { verdict: "uncertain", documentType: null } }) });
    expect(c).toMatchObject({ decision: "needs_review" });
  });

  it("turns an attachment that cannot be downloaded into an uncertain document, not a crash", async () => {
    const m = email({ subject: "Invoice", attachments: [pdf("x.pdf")] });
    const r = await classifyEmail(m, { ctx, loadAttachment: async () => { throw new Error("404"); }, readDocument: reader({}) });
    expect(r.classification.decision).toBe("needs_review");
    expect(r.readings[0]?.signals).toContain("ATTACHMENT_UNREADABLE");
  });
});

describe("email-text classifier (no document)", () => {
  const followUp = email({ subject: "Following up" });

  it("uses Claude's verdict", async () => {
    const llm: LlmClassifier = async () => ({ decision: "needs_review", kind: "vendor_inquiry", reason: "Asks about payment." });
    expect((await classifyEmail(followUp, { ctx, llm })).classification).toMatchObject({ decision: "needs_review", decidedBy: "llm" });
  });

  it("shows Claude the rule facts and the email inside <email> tags", async () => {
    const llm = vi.fn<LlmClassifier>(async () => ({ decision: "ignored", kind: "other", reason: "x" }));
    await classifyEmail(followUp, { ctx, llm });
    expect(llm.mock.calls[0]![0].text).toContain("<email>");
    expect(llm.mock.calls[0]![0].text).toContain("KNOWN_VENDOR_SENDER");
  });

  it("can never create a bill without a document", async () => {
    const llm: LlmClassifier = async () => ({ decision: "invoice", kind: "invoice", reason: "x" });
    const { classification: c } = await classifyEmail(followUp, { ctx, llm });
    expect(c).toMatchObject({ decision: "needs_review", kind: "missing_attachment", invoiceAttachments: [] });
    expect(c.signals).toContain("GUARD_NO_DOCUMENT");
  });

  it("retries once, then falls back to review with the error — never drops", async () => {
    const llm = vi.fn<LlmClassifier>(async () => { throw new Error("overloaded"); });
    const { classification: c } = await classifyEmail(followUp, { ctx, llm });
    expect(llm).toHaveBeenCalledTimes(2);
    expect(c).toMatchObject({ decision: "needs_review", decidedBy: "fallback" });
    expect(c.reason).toContain("overloaded");
  });
});

describe("dataset inbox, no model (text rules only)", async () => {
  const emails = fromDatasetFile(JSON.parse(readFileSync(`${DATASET_DIR}/inbox/emails.json`, "utf8"))).map((e) => InboxMessage.parse(e));
  const deps: ClassifyDeps = {
    ctx: { knownVendorDomains: vendorDomainsFromCsv() },
    loadAttachment: async (_m, a) => readFileSync(`${DATASET_DIR}/incoming_invoices/${a.sourceRef}`),
    readDocument: (d) => readDocument(d, {}),
  };
  const results = await Promise.all(emails.map((m) => classifyEmail(m, deps)));

  it("never drops an email: every one gets a decision with a reason", () => {
    expect(results).toHaveLength(emails.length);
    for (const r of results) expect(r.classification.reason.length).toBeGreaterThan(10);
  });

  it("drafts a bill for every text PDF (all are invoices or credit notes) and sends scans to a person", () => {
    const bills = results.flatMap((r) => r.readings.filter((d) => d.verdict === "bill"));
    const pdfs = emails.flatMap((e) => e.attachments).filter((a) => a.filename.endsWith(".pdf"));
    expect(bills).toHaveLength(pdfs.length);
    expect(bills.filter((b) => b.documentType === "credit_note").length).toBeGreaterThan(0);
    const scans = results.flatMap((r) => r.readings).filter((d) => d.filename.endsWith(".png"));
    for (const s of scans) expect(s.verdict).toBe("uncertain");
  });

  it("keeps the emails without attachments out of the bill queue", () => {
    for (const [i, e] of emails.entries()) {
      if (e.attachments.length === 0) expect(results[i]!.classification.decision).not.toBe("invoice");
    }
  });
});
