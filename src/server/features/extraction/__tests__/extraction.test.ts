import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parseAmountToCents, parsePaymentTermsDays } from "../amounts";
import type { LlmExtractor } from "../claude";
import { classifyDocumentText } from "../doc-type-rules";
import { normalizeExtraction } from "../normalize";
import type { LlmExtraction } from "../prompt";
import { readDocument } from "../read-document";

describe("parseAmountToCents", () => {
  it.each([
    ["$3,000.30", 300030], ["-$1,042.76", -104276], ["(185.71)", -18571], ["2 260,00 $", 226000],
    ["1.234,56", 123456], ["1'234.50", 123450], ["USD 12", 1200], ["12.5", 1250], ["$0.00", 0],
    ["185.71 CR", -18571], ["−$5.00", -500],
  ])("%s → %d", (raw, cents) => expect(parseAmountToCents(raw)).toBe(cents));

  it.each(["", "abc", "12.3.4", "1234.567", "1,23,456.00"])("rejects %j", (raw) => expect(parseAmountToCents(raw)).toBeNull());
});

describe("parsePaymentTermsDays", () => {
  it.each([["Net 30", 30], ["30 jours net", 30], ["Due on receipt", 0], ["Payable à réception", 0], ["", null], ["2/10", null]])(
    "%s → %s", (raw, days) => expect(parsePaymentTermsDays(raw)).toBe(days));
});

describe("document-type rules on the PDF's own text", () => {
  const invoice = "Acme Ltd\nGST/HST 123\nINVOICE\nInvoice Number: 42\nSubtotal $10.00\nTotal CAD $11.30";
  it("recognises an invoice", () => expect(classifyDocumentText(invoice)).toMatchObject({ verdict: "bill_likely", documentType: "invoice" }));

  it("lets a CREDIT NOTE title win over an 'Invoice Number' field", () => {
    expect(classifyDocumentText("Acme\nCREDIT NOTE\nInvoice Number: CN-1\nTotal -$5.00"))
      .toMatchObject({ verdict: "bill_likely", documentType: "credit_note" });
  });

  it("reads French", () => {
    expect(classifyDocumentText("Fournisseur Inc.\nFACTURE\nNo de facture : 77\nTotal 113,00 $").verdict).toBe("bill_likely");
  });

  it.each([
    ["Acme\nRECEIPT\nPaid by Visa ****1234\nTotal $10.00", "receipt"],
    ["Acme\nStatement of Account\nOpening balance $100\nTotal $100", "statement"],
    ["Acme\nQuotation\nValid 30 days\nTotal $500", "quote"],
    ["Acme\nTerms and Conditions\n1. Scope", "other"],
  ])("skips the model for a clear non-bill: %j", (text, type) => {
    expect(classifyDocumentText(text)).toMatchObject({ verdict: "not_bill", documentType: type });
  });

  it("does not skip a receipt that mentions an invoice — the model decides", () => {
    expect(classifyDocumentText("Acme\nRECEIPT\nPayment for invoice 42\nTotal $10").verdict).toBe("unknown");
  });

  it("does not read 'Payment terms: Due on receipt' as a receipt", () => {
    expect(classifyDocumentText("Acme\nTAX INVOICE\nInvoice No.: 9\nPayment terms: Due on receipt\nTotal $5")).toMatchObject({ verdict: "bill_likely" });
  });

  it("does not take an 'Invoice Number:' field for a title", () => {
    expect(classifyDocumentText("Acme\nPacking list\nInvoice Number: 42\nTotal 3 boxes").verdict).toBe("unknown");
  });

  it("lets the model judge a document titled both INVOICE and PAID RECEIPT", () => {
    expect(classifyDocumentText("Acme\nINVOICE\nReceipt - paid in full\nInvoice No: 4\nTotal $10")).toMatchObject({ verdict: "unknown" });
  });

  it("does not call a statement listing invoices 'not a bill' by rules alone", () => {
    expect(classifyDocumentText("Acme\nStatement of Account\nInvoice 1 $10\nInvoice 2 $20").verdict).not.toBe("not_bill");
  });
});

const llmReply = (over: Partial<LlmExtraction> = {}): LlmExtraction => ({
  documentType: "invoice", documentTypeReason: "Titled INVOICE.", language: "en",
  vendorName: "Acme Ltd", vendorGstHstNumber: "123456789RT0001", vendorQstNumber: "", vendorAddress: "1 Main St, Toronto ON",
  vendorProvinceOrState: "on", vendorCountry: "ca", invoiceNumber: "A-1", invoiceDate: "2026-10-19", dueDate: "2026-11-18",
  currency: "cad", paymentTerms: "Net 30", poNumber: "", contractRef: "", creditNoteRef: "",
  billToName: "Harborline", billToAddress: "", billToProvince: "on", shipToProvince: "",
  lines: [{ description: "Pallets", quantity: "219", unitPrice: "$13.70", amount: "$3,000.30", lineType: "goods" }],
  taxes: [{ label: "HST (13%)", ratePercent: "13", amount: "$390.04", code: "HST13" }],
  subtotal: "$3,000.30", total: "$3,390.34", statedFxRate: "",
  remitInstitution: "016", remitTransit: "95739", remitAccount: "97756574",
  confidence: { documentType: 0.99, vendor: 0.95, invoiceNumber: 0.99, invoiceDate: 0.99, dueDate: 0.99, lines: 0.9, taxes: 0.95, total: 1.4 },
  ...over,
});

describe("normalizeExtraction", () => {
  it("turns printed amounts into cents and terms into days, deterministically", () => {
    const x = normalizeExtraction(llmReply());
    expect(x).toMatchObject({
      totalCents: 339034, subtotalCents: 300030, paymentTermsDays: 30, currency: "CAD",
      vendor: { province: "ON", country: "CA", qstNumber: null },
      lines: [{ lineNo: 1, quantity: 219, unitPriceCents: 1370, amountCents: 300030, lineType: "goods" }],
      taxes: [{ code: "HST13", amountCents: 39004, ratePct: 13 }],
      remitTo: { institution: "016", transit: "95739", account: "97756574" },
    });
    expect(x.confidence.totalCents).toBe(1); // clamped
  });

  it("keeps unreadable values null with a warning instead of guessing", () => {
    const x = normalizeExtraction(llmReply({ total: "3,39O.34", invoiceDate: "19/10/2026" }));
    expect(x.totalCents).toBeNull();
    expect(x.invoiceDate).toBeNull();
    expect(x.warnings.join(" ")).toMatch(/total .* not a readable amount/);
  });

  it("stores credit notes as negative even when printed positive", () => {
    const x = normalizeExtraction(llmReply({ documentType: "credit_note", total: "$113.00", subtotal: "$100.00",
      taxes: [{ label: "HST", ratePercent: "13", amount: "$13.00", code: "HST13" }] }));
    expect(x.totalCents).toBe(-11300);
    expect(x.taxes[0]!.amountCents).toBe(-1300);
    expect(x.warnings).toContain("credit note printed positive amounts; stored as negative");
  });

  it("maps UNMAPPED tax lines to a null code (never 'no tax')", () => {
    expect(normalizeExtraction(llmReply({ taxes: [{ label: "Eco fee", ratePercent: "", amount: "$2.00", code: "UNMAPPED" }] })).taxes[0])
      .toMatchObject({ code: null, amountCents: 200 });
  });
});

describe("readDocument verdicts", () => {
  const pdfBytes = readFileSync("brim_ap_dataset/brim_ap_dataset/incoming_invoices/keystonerackings-inv-002.pdf");
  const doc = { sourceRef: "k.pdf", filename: "k.pdf", mime: "application/pdf", bytes: pdfBytes };

  it("sends the text layer, not the PDF, when there is one", async () => {
    const llm = vi.fn<LlmExtractor>(async () => llmReply());
    const r = await readDocument(doc, { llm });
    expect(llm.mock.calls[0]![0].kind).toBe("text");
    expect(r).toMatchObject({ verdict: "bill", documentType: "invoice", decidedBy: "llm" });
    expect(r.textLayerChars).toBeGreaterThan(100);
  });

  it("asks a person when the text says invoice but the model says otherwise", async () => {
    const r = await readDocument(doc, { llm: async () => llmReply({ documentType: "receipt", documentTypeReason: "Marked PAID." }) });
    expect(r.verdict).toBe("uncertain");
    expect(r.signals).toContain("RULES_MODEL_DISAGREE");
  });

  it("keeps a text-invoice as a bill for manual entry when the model fails twice", async () => {
    const llm = vi.fn<LlmExtractor>(async () => { throw new Error("timeout"); });
    const r = await readDocument(doc, { llm });
    expect(llm).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ verdict: "bill", decidedBy: "fallback", extracted: null });
    expect(r.reason).toContain("manual entry");
  });

  it("sends a scan to the model as an image", async () => {
    const llm = vi.fn<LlmExtractor>(async () => llmReply());
    await readDocument({ sourceRef: "s", filename: "scan.png", mime: "image/png", bytes: Buffer.from("png") }, { llm });
    expect(llm.mock.calls[0]![0].kind).toBe("image");
  });

  it("marks a scan uncertain when no model is configured", async () => {
    const r = await readDocument({ sourceRef: "s", filename: "scan.png", mime: "image/png", bytes: Buffer.from("png") }, {});
    expect(r.verdict).toBe("uncertain");
  });
});
