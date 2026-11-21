import { ExtractedDocument, type ExtractedDocumentInput } from "@/contracts/extraction";
import { parseAmountToCents, parsePaymentTermsDays } from "./amounts";
import type { LlmExtraction } from "./prompt";

/**
 * The model's as-printed reply → the ExtractedDocument contract, with deterministic code only.
 * Anything unreadable becomes null plus a warning the clerk sees; nothing is guessed.
 */

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeExtraction(x: LlmExtraction): ExtractedDocument {
  const warnings: string[] = [];
  const cents = (label: string, raw: string): number | null => {
    if (raw.trim() === "") return null;
    const v = parseAmountToCents(raw);
    if (v === null) warnings.push(`${label} "${raw}" is not a readable amount`);
    return v;
  };
  const date = (label: string, raw: string): string | null => {
    const s = raw.trim();
    if (s === "") return null;
    if (!ISO.test(s)) { warnings.push(`${label} "${s}" is not YYYY-MM-DD`); return null; }
    return s;
  };
  const decimal = (label: string, raw: string): number | null => {
    const s = raw.trim().replace(",", ".");
    if (s === "") return null;
    const n = Number(s.replace(/[^\d.-]/g, ""));
    if (!Number.isFinite(n)) { warnings.push(`${label} "${raw}" is not a number`); return null; }
    return n;
  };

  const lines = x.lines.map((l, i) => ({
    lineNo: i + 1,
    description: l.description,
    quantity: decimal(`line ${i + 1} quantity`, l.quantity) ?? 1,
    unitPriceCents: cents(`line ${i + 1} unit price`, l.unitPrice) ?? cents(`line ${i + 1} amount`, l.amount) ?? 0,
    amountCents: cents(`line ${i + 1} amount`, l.amount) ?? 0,
    lineType: l.lineType === "unknown" ? null : l.lineType,
  }));
  const taxes = x.taxes.map((t, i) => ({
    code: t.code === "UNMAPPED" ? null : t.code,
    label: t.label,
    ratePct: decimal(`tax ${i + 1} rate`, t.ratePercent),
    amountCents: cents(`tax ${i + 1} (${t.label}) amount`, t.amount) ?? 0,
  }));
  let subtotalCents = cents("subtotal", x.subtotal);
  let totalCents = cents("total", x.total);

  // Credit notes are negative everywhere downstream (money-and-tax.md). Some print positive
  // amounts under a CREDIT NOTE title; flip them and say so.
  if (x.documentType === "credit_note" && totalCents !== null && totalCents > 0) {
    warnings.push("credit note printed positive amounts; stored as negative");
    totalCents = -totalCents;
    subtotalCents = subtotalCents === null ? null : -Math.abs(subtotalCents);
    for (const l of lines) { l.amountCents = -Math.abs(l.amountCents); l.unitPriceCents = -Math.abs(l.unitPriceCents); }
    for (const t of taxes) t.amountCents = -Math.abs(t.amountCents);
  }

  const remit = [x.remitInstitution, x.remitTransit, x.remitAccount].some((s) => s.trim() !== "")
    ? { institution: x.remitInstitution, transit: x.remitTransit, account: x.remitAccount }
    : null;

  const c = x.confidence;
  const out: ExtractedDocumentInput = {
    documentType: x.documentType,
    documentTypeReason: x.documentTypeReason,
    language: x.language,
    vendor: {
      nameRaw: x.vendorName, gstHstNumber: x.vendorGstHstNumber, qstNumber: x.vendorQstNumber,
      address: x.vendorAddress, province: x.vendorProvinceOrState.toUpperCase(), country: x.vendorCountry.toUpperCase(),
    },
    invoiceNumber: x.invoiceNumber,
    invoiceDate: date("invoice date", x.invoiceDate),
    dueDate: date("due date", x.dueDate),
    currency: x.currency.trim().toUpperCase().replace(/^\$$/, "") || null,
    paymentTermsDays: parsePaymentTermsDays(x.paymentTerms),
    poNumber: x.poNumber, contractRef: x.contractRef, creditNoteRef: x.creditNoteRef,
    billTo: { name: x.billToName, address: x.billToAddress, province: x.billToProvince.toUpperCase() },
    shipToProvince: x.shipToProvince.toUpperCase(),
    lines, taxes, subtotalCents, totalCents,
    statedFxRate: (() => { const r = decimal("stated FX rate", x.statedFxRate); return r && r > 0 ? r : null; })(),
    remitTo: remit,
    confidence: {
      documentType: clamp01(c.documentType), vendor: clamp01(c.vendor), invoiceNumber: clamp01(c.invoiceNumber),
      invoiceDate: clamp01(c.invoiceDate), dueDate: clamp01(c.dueDate), lines: clamp01(c.lines),
      taxes: clamp01(c.taxes), totalCents: clamp01(c.total),
    },
    warnings,
  };
  return ExtractedDocument.parse(out);
}
