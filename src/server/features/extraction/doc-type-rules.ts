import type { DocumentType } from "@/contracts/extraction";

/**
 * Deterministic document-type checks on a PDF's own text (not the email). Every check is here.
 *
 * Conservative on purpose — rules may only say:
 *   - "bill_likely"  : titled invoice/facture/credit note AND has an invoice number or a total.
 *                      The model still reads it (we need the fields); if it disagrees → clerk.
 *   - "not_bill"     : titled receipt/statement/quote/… AND the words invoice/facture appear
 *                      NOWHERE in the document. Only this skips the model entirely.
 *   - "unknown"      : everything else → the model decides.
 * A wrong "not_bill" would lose a bill silently, so it needs both conditions.
 */

/** Payment terms that contain a non-bill word ("Due on receipt") are ordinary invoice wording. */
const BENIGN_TERMS = /\b(?:due|payable)\s+(?:up)?on\s+receipt\b|\bnet\s+on\s+receipt\b|\bpayable\s+(?:a|des)\s+(?:la\s+)?reception\b/g;
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(BENIGN_TERMS, " ");
/** The title is in the top of the first page. */
const TITLE_LINES = 15;

/** A title LINE starts with the word and is not a field label ("Invoice Number: 42" is not a title). */
const NOT_A_FIELD = String.raw`(?![ \t]*(?:no\b|number|num|#|n[o°º]\b|date|ref|total))`; // same line only
const CREDIT_TITLE = new RegExp(String.raw`^(credit note|credit memo|note de credit)\b${NOT_A_FIELD}`, "m");
const INVOICE_TITLE = new RegExp(String.raw`^(?:tax\s+)?(invoice|facture)\b${NOT_A_FIELD}`, "m");
const INVOICE_ANYWHERE = /\b(invoice|invoices|facture|factures)\b/;
const INVOICE_NUMBER = /\b(invoice|facture|inv)\s*(no\.?|number|num(?:ero)?|#|n[o°º])/;
const TOTAL = /\b(total|amount due|balance due|montant du|solde)\b[^\n]*\d/;

/** Non-bill titles → the document type they mean. Order matters: first match wins. */
const NOT_BILL_TITLES: [RegExp, DocumentType][] = [
  [/\b(statement of account|account statement|releve de compte|etat de compte)\b/, "statement"],
  [/\b(remittance advice|avis de paiement|payment advice)\b/, "remittance_advice"],
  [/\b(receipt|recu|payment confirmation|paid in full)\b/, "receipt"],
  [/\b(quote|quotation|estimate|soumission|devis)\b/, "quote"],
  [/\b(purchase order|bon de commande)\b/, "purchase_order"],
  [/\b(terms and conditions|conditions generales|packing slip|bordereau|delivery note|bon de livraison|price list|liste de prix|catalog|catalogue|brochure|newsletter)\b/, "other"],
];

export interface DocTypeRuleResult {
  verdict: "bill_likely" | "not_bill" | "unknown";
  documentType: DocumentType | null;
  reason: string;
  signals: string[];
}

export function classifyDocumentText(text: string): DocTypeRuleResult {
  const all = norm(text);
  const title = all.split(/\n/).map((l) => l.trim()).filter(Boolean).slice(0, TITLE_LINES).join("\n");
  const signals: string[] = [];
  const hasNumber = INVOICE_NUMBER.test(all);
  const hasTotal = TOTAL.test(all);
  if (hasNumber) signals.push("DOC_INVOICE_NUMBER");
  if (hasTotal) signals.push("DOC_TOTAL");

  // A bill title next to a non-bill title ("INVOICE" … "RECEIPT — PAID") is for the model to judge.
  const notBillInTitle = NOT_BILL_TITLES.find(([re]) => re.test(title));
  if (notBillInTitle && (CREDIT_TITLE.test(title) || INVOICE_TITLE.test(title))) {
    signals.push("DOC_TITLE_CONFLICT");
    return { verdict: "unknown", documentType: null, signals,
      reason: `Document has both a bill title and "${title.match(notBillInTitle[0])![1]}" — needs judgment.` };
  }

  const credit = title.match(CREDIT_TITLE);
  if (credit && (hasNumber || hasTotal)) {
    signals.push("DOC_TITLE_CREDIT_NOTE");
    return { verdict: "bill_likely", documentType: "credit_note", signals,
      reason: `Document is titled "${credit[1]}" and has ${hasNumber ? "a document number" : "a total"}.` };
  }
  const invoice = title.match(INVOICE_TITLE);
  if (invoice && (hasNumber || hasTotal)) {
    signals.push("DOC_TITLE_INVOICE");
    return { verdict: "bill_likely", documentType: "invoice", signals,
      reason: `Document is titled "${invoice[1]}" and has ${hasNumber && hasTotal ? "an invoice number and a total" : hasNumber ? "an invoice number" : "a total"}.` };
  }

  if (!INVOICE_ANYWHERE.test(all)) {
    for (const [re, type] of NOT_BILL_TITLES) {
      const m = title.match(re);
      if (m) {
        signals.push("DOC_TITLE_NOT_BILL", "DOC_NO_INVOICE_WORD");
        return { verdict: "not_bill", documentType: type, signals,
          reason: `Document is titled "${m[1]}" and never mentions an invoice — not a bill.` };
      }
    }
  }
  signals.push("DOC_TYPE_UNCLEAR");
  return { verdict: "unknown", documentType: null, signals, reason: "Document text does not settle its type." };
}
