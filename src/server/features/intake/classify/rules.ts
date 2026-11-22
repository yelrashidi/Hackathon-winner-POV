import type { InboxAttachment, InboxMessage, IntakeClassification } from "@/contracts/intake";
import { mimeFromFilename } from "../dataset/emails";

/**
 * Every deterministic intake check, in one file. Read top to bottom:
 *   1. which attachments are documents a bill could be read from
 *   2. which word lists (English + French) match the subject, body and file names
 *   3. who sent it (a known vendor domain or not)
 *   4. decideByRules(): the no-document cases rules settle alone; the rest goes to Claude
 *
 * Email wording NEVER makes a bill: an email with document attachments is decided by reading
 * each document (extraction's readDocument, see classify.ts). These rules only settle emails
 * without a readable document. No vendor names, invoice numbers or amounts from the dataset
 * appear here (CLAUDE.md hard rule 4).
 */

// ── 1. Attachments ─────────────────────────────────────────────────────────────────────────

/** Formats extraction can read a bill from. */
const DOCUMENT_MIME = new Set(["application/pdf", "image/png", "image/jpeg", "image/tiff", "image/heic", "image/webp"]);
/** Images smaller than this are logos, signatures and tracking pixels, not scanned invoices. */
export const MIN_IMAGE_BYTES = 20_000;

export type AttachmentVerdict = "document" | "small_image" | "unsupported";

export function effectiveMime(a: InboxAttachment): string {
  // Senders often say application/octet-stream; the file name is then the better hint.
  return a.mimeType === "application/octet-stream" ? mimeFromFilename(a.filename) : a.mimeType;
}

export function attachmentVerdict(a: InboxAttachment): AttachmentVerdict {
  const mime = effectiveMime(a);
  if (!DOCUMENT_MIME.has(mime)) return "unsupported";
  if (mime.startsWith("image/") && a.sizeBytes !== null && a.sizeBytes < MIN_IMAGE_BYTES) return "small_image";
  return "document";
}

// ── 2. Word lists ──────────────────────────────────────────────────────────────────────────
// Matched on lower-cased, accent-stripped text ("Reçu" → "recu"), on word boundaries.

export const TERMS = {
  /** The email is about a bill. */
  INVOICE_TERMS: [
    "invoice", "invoices", "inv", "facture", "factures", "bill", "billing", "amount due", "payment due",
    "balance due", "past due", "due date", "montant du", "paiement du", "date d'echeance",
    "credit note", "credit memo", "note de credit",
  ],
  /** Already paid: not something to pay again. */
  RECEIPT_TERMS: [
    "receipt", "recu", "payment received", "payment confirmation", "thank you for your payment",
    "thanks for your payment", "thank you for paying", "paid in full", "order confirmation",
    "paiement recu", "merci pour votre paiement", "confirmation de commande",
  ],
  MARKETING_TERMS: [
    "unsubscribe", "newsletter", "% off", "sale", "promo", "promotion", "webinar", "limited time",
    "special offer", "se desabonner", "infolettre", "rabais", "soldes",
  ],
  STATEMENT_TERMS: ["statement of account", "account statement", "monthly statement", "releve de compte", "etat de compte"],
  /** A vendor asking us something; routed to a person, never a bill. */
  INQUIRY_TERMS: [
    "where is payment", "where is my payment", "where is our payment", "payment status", "status of payment",
    "not received payment", "have not received payment", "haven't received payment", "still unpaid",
    "ou en est le paiement", "pas recu le paiement",
  ],
} as const;
export type TermGroup = keyof typeof TERMS;

export function normalizeText(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[’`]/g, "'").toLowerCase();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TERM_RES = Object.fromEntries(
  Object.entries(TERMS).map(([group, terms]) => [
    group,
    // Word boundaries only on sides that start/end with a letter or digit ("20% off" must match "% off").
    terms.map((t) => ({
      term: t,
      re: new RegExp(`${/^[a-z0-9]/.test(t) ? "(^|[^a-z0-9])" : ""}${escapeRe(t)}${/[a-z0-9]$/.test(t) ? "($|[^a-z0-9])" : ""}`),
    })),
  ]),
) as Record<TermGroup, { term: string; re: RegExp }[]>;

/** Payment-terms phrases that contain a warning word but are ordinary invoice wording. */
const BENIGN_PHRASES = /\b(?:due|payable)\s+(?:up)?on\s+receipt\b|\bnet\s+on\s+receipt\b/g;

export function matchTerms(text: string): Record<TermGroup, string[]> {
  const norm = normalizeText(text).replace(BENIGN_PHRASES, " ");
  const out = {} as Record<TermGroup, string[]>;
  for (const group of Object.keys(TERM_RES) as TermGroup[]) {
    out[group] = TERM_RES[group].filter(({ re }) => re.test(norm)).map(({ term }) => term);
  }
  return out;
}

// ── 3. Sender ──────────────────────────────────────────────────────────────────────────────

export function senderDomain(address: string): string {
  return address.split("@").pop()?.trim().toLowerCase() ?? "";
}

// ── 4. Decision ────────────────────────────────────────────────────────────────────────────

export interface RuleContext {
  /** Domains of vendor AP contacts from the vendor master (lower-case). */
  knownVendorDomains: ReadonlySet<string>;
}

export interface RuleFindings {
  documents: InboxAttachment[];
  skipped: { attachment: InboxAttachment; verdict: Exclude<AttachmentVerdict, "document"> }[];
  terms: Record<TermGroup, string[]>;
  knownVendor: boolean;
  /** Stable codes of every check that fired. */
  signals: string[];
}

export function inspect(msg: InboxMessage, ctx: RuleContext): RuleFindings {
  const documents: InboxAttachment[] = [];
  const skipped: RuleFindings["skipped"] = [];
  for (const a of msg.attachments) {
    const v = attachmentVerdict(a);
    if (v === "document") documents.push(a);
    else skipped.push({ attachment: a, verdict: v });
  }
  // File names count as text: "Facture_4443.pdf" is evidence too.
  const text = [msg.subject, msg.bodyText, ...msg.attachments.map((a) => a.filename.replace(/[_\-.]+/g, " "))].join("\n");
  const terms = matchTerms(text);
  const knownVendor = ctx.knownVendorDomains.has(senderDomain(msg.fromAddress));

  const signals: string[] = [];
  if (documents.length) signals.push("ATTACHMENT_DOCUMENT");
  if (skipped.some((s) => s.verdict === "small_image")) signals.push("ATTACHMENT_SMALL_IMAGE_SKIPPED");
  if (skipped.some((s) => s.verdict === "unsupported")) signals.push("ATTACHMENT_UNSUPPORTED");
  if (msg.attachments.length === 0) signals.push("NO_ATTACHMENT");
  for (const g of Object.keys(terms) as TermGroup[]) if (terms[g].length) signals.push(g);
  signals.push(knownVendor ? "KNOWN_VENDOR_SENDER" : "UNKNOWN_SENDER");
  return { documents, skipped, terms, knownVendor, signals };
}

const quote = (terms: readonly string[]) => terms.map((t) => `"${t}"`).join(", ");

/**
 * The no-document cases rules settle alone. Returns null when the email has documents (they are
 * read one by one) or needs judgment (→ Claude reads the email text).
 */
export function decideByRules(f: RuleFindings): IntakeClassification | null {
  const { terms, documents, signals } = f;
  if (documents.length > 0) return null;

  const warnings = [...terms.RECEIPT_TERMS, ...terms.MARKETING_TERMS, ...terms.STATEMENT_TERMS, ...terms.INQUIRY_TERMS];
  const sender = f.knownVendor ? "known vendor" : "unknown sender";
  const result = (c: Pick<IntakeClassification, "decision" | "kind" | "reason">): IntakeClassification =>
    ({ ...c, invoiceAttachments: [], documents: [], decidedBy: "rules", signals });
  if (terms.INQUIRY_TERMS.length > 0) {
    return result({ decision: "needs_review", kind: "vendor_inquiry",
      reason: `Payment question (${quote(terms.INQUIRY_TERMS)}) from ${sender}, no invoice attached — route to AP clerk.` });
  }
  if (terms.STATEMENT_TERMS.length > 0) {
    return result({ decision: "needs_review", kind: "statement",
      reason: `Statement of account (${quote(terms.STATEMENT_TERMS)}) from ${sender} — not a bill; clerk reconciles it against open invoices.` });
  }
  if (terms.INVOICE_TERMS.length > 0 && warnings.length === 0) {
    const unsupported = f.skipped.map((s) => s.attachment.filename);
    return result({ decision: "needs_review", kind: "missing_attachment",
      reason: unsupported.length
        ? `Mentions an invoice (${quote(terms.INVOICE_TERMS)}) but no readable attachment (${unsupported.join(", ")}) — ask the sender for a PDF.`
        : `Mentions an invoice (${quote(terms.INVOICE_TERMS)}) but has no attachment — ask the sender to resend it.` });
  }
  if (terms.INVOICE_TERMS.length === 0 && terms.RECEIPT_TERMS.length > 0 && terms.MARKETING_TERMS.length === 0) {
    return result({ decision: "ignored", kind: "receipt",
      reason: `Payment confirmation / receipt (${quote(terms.RECEIPT_TERMS)}) with no bill attached — nothing to pay.` });
  }
  if (terms.INVOICE_TERMS.length === 0 && terms.MARKETING_TERMS.length > 0) {
    return result({ decision: "ignored", kind: "marketing",
      reason: `Promotional email (${quote(terms.MARKETING_TERMS)}) with no bill attached.` });
  }
  if (terms.INVOICE_TERMS.length === 0 && warnings.length === 0 && !f.knownVendor) {
    return result({ decision: "ignored", kind: "personal",
      reason: "No attachment, no accounts-payable wording and the sender is not a known vendor — not AP mail." });
  }
  return null; // e.g. a known vendor writing without keywords → Claude
}
