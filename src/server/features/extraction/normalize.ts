import { ExtractedDocument, type ExtractedDocumentInput } from "@/contracts/extraction";
import { parseAmountToCents, parsePaymentTermsDays } from "./amounts";
import type { LlmExtraction } from "./prompt";

/**
 * The model's as-printed reply → the ExtractedDocument contract, with deterministic code only.
 * Unreadable optional fields become null. Required numeric line fields retain contract-safe
 * placeholders, with a warning and zero line confidence so a clerk must check them.
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
    const numeric = s.replace(/[^\d.-]/g, "");
    const n = numeric ? Number(numeric) : NaN;
    if (!Number.isFinite(n)) { warnings.push(`${label} "${raw}" is not a number`); return null; }
    return n;
  };

  let incompleteLines = false;
  const lines = x.lines.map((l, i) => {
    const label = `line ${i + 1}`;
    const quantity = decimal(`${label} quantity`, l.quantity);
    const unitPriceCents = cents(`${label} unit price`, l.unitPrice);
    const amountCents = cents(`${label} amount`, l.amount);
    for (const [field, value, placeholder] of [
      ["quantity", quantity, 1], ["unit price", unitPriceCents, 0], ["amount", amountCents, 0],
    ] as const) {
      if (value !== null) continue;
      incompleteLines = true;
      warnings.push(`${label} ${field} is missing or unreadable; ${placeholder} is a placeholder for manual review`);
    }
    return {
      lineNo: i + 1,
      description: l.description,
      quantity: quantity ?? 1,
      unitPriceCents: unitPriceCents ?? 0,
      amountCents: amountCents ?? 0,
      lineType: l.lineType === "unknown" ? null : l.lineType,
    };
  });
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
  if (x.documentType === "credit_note") {
    let changed = false;
    const negative = (amount: number): number => {
      if (amount > 0) changed = true;
      return amount === 0 ? 0 : -Math.abs(amount);
    };
    totalCents = totalCents === null ? null : negative(totalCents);
    subtotalCents = subtotalCents === null ? null : negative(subtotalCents);
    for (const l of lines) { l.amountCents = negative(l.amountCents); l.unitPriceCents = negative(l.unitPriceCents); }
    for (const t of taxes) t.amountCents = negative(t.amountCents);
    if (changed) warnings.push("credit note printed positive amounts; stored as negative");
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
      invoiceDate: clamp01(c.invoiceDate), dueDate: clamp01(c.dueDate), lines: incompleteLines ? 0 : clamp01(c.lines),
      taxes: clamp01(c.taxes), totalCents: clamp01(c.total),
    },
    warnings,
  };
  return ExtractedDocument.parse(out);
}
