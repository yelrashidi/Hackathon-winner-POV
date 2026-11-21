import { z } from "zod";

/**
 * Feature 1 — intake. `InboxMessage` is one email as intake hands it to classification, whatever
 * mailbox it came from: the live Gmail connector, the dataset's `inbox/emails.json`, or a manual
 * upload. Every source is mapped into this one shape, so the classifier and the draft-bill code
 * exist once and are scored identically on hidden data.
 *
 * Attachment bytes are NOT in the contract: `sourceRef` says where to fetch them (a Gmail
 * attachment id, or a dataset file name). Documents are stored once, by sha256, when a draft
 * bill is created.
 *
 * Email text is data, never instructions (docs/rules/backend.md).
 * Rules for changing this file: docs/rules/contracts.md.
 */

const blankToNull = (s: string | null): string | null => (s === null || s.trim() === "" ? null : s.trim());
const nullableString = z.string().nullable().transform(blankToNull).default(null);

export const InboxSource = z.enum(["gmail", "dataset", "upload"]);
export type InboxSource = z.infer<typeof InboxSource>;

export const InboxAttachment = z.object({
  filename: z.string().trim().min(1),
  /** As declared by the sender; "application/octet-stream" when unknown. Not trusted for routing alone. */
  mimeType: z.string().trim().toLowerCase().default("application/octet-stream"),
  sizeBytes: z.number().int().nonnegative().nullable().default(null),
  /** Where the bytes live: Gmail attachment id, or the dataset file name under incoming_invoices/. */
  sourceRef: z.string().min(1),
});
export type InboxAttachment = z.infer<typeof InboxAttachment>;

export const InboxMessage = z.object({
  source: InboxSource,
  /** Stable id inside the source (Gmail message id, dataset `email_id`). (source, externalId) is unique. */
  externalId: z.string().trim().min(1),
  threadId: nullableString,
  fromName: nullableString,
  /** Lower-cased bare address, no display name. Lookalike-domain checks compare its domain. */
  fromAddress: z.string().trim().toLowerCase(),
  toAddress: nullableString,
  subject: z.string().default(""),
  /** ISO 8601. Gmail gives UTC (`Z`); the dataset gives local time with no offset. */
  receivedAt: z.iso.datetime({ offset: true, local: true }),
  /** Plain-text body (HTML stripped when the email had no text part). */
  bodyText: z.string().default(""),
  attachments: z.array(InboxAttachment).default([]),
});
export type InboxMessage = z.infer<typeof InboxMessage>;
export type InboxMessageInput = z.input<typeof InboxMessage>;

/**
 * What intake decided about one email. Three outcomes, never a silent drop:
 * - `invoice`      → each `invoiceAttachments` entry becomes one draft bill (status Received).
 * - `needs_review` → the clerk's triage queue (missing attachment, vendor question, statement, unsure).
 * - `ignored`      → kept with its reason, out of the bill queue (marketing, receipts, personal mail).
 */
export const IntakeDecision = z.enum(["invoice", "needs_review", "ignored"]);
export type IntakeDecision = z.infer<typeof IntakeDecision>;

export const IntakeKind = z.enum([
  "invoice",            // bill or credit note (extraction tells them apart)
  "missing_attachment", // talks about an invoice, nothing usable attached
  "vendor_inquiry",     // "where is my payment?", remittance questions
  "statement",          // statement of account
  "receipt",            // already paid: receipts, payment confirmations, "thanks for paying"
  "marketing",
  "personal",           // not accounts-payable mail at all
  "other",
]);
export type IntakeKind = z.infer<typeof IntakeKind>;

export const IntakeClassification = z.object({
  decision: IntakeDecision,
  kind: IntakeKind,
  /** Shown verbatim in the UI. Names the evidence: words matched, attachments, sender. */
  reason: z.string().min(1),
  /** `sourceRef`s of attachments that become draft bills; empty unless decision is `invoice`. */
  invoiceAttachments: z.array(z.string()).default([]),
  /** Who decided: deterministic rules, Claude, or the safe fallback after Claude failed. */
  decidedBy: z.enum(["rules", "llm", "fallback"]),
  /** Rule codes that fired (SCREAMING_SNAKE, stable), for the audit trail and tests. */
  signals: z.array(z.string()).default([]),
  /**
   * The verdict on each document attachment, read from the document itself (extraction).
   * Only `bill` documents are in `invoiceAttachments`; the others stay visible with their reason.
   */
  documents: z.array(z.object({
    sourceRef: z.string(),
    filename: z.string(),
    verdict: z.enum(["bill", "not_bill", "uncertain"]),
    documentType: z.string().nullable(),
    reason: z.string(),
  })).default([]),
});
export type IntakeClassification = z.infer<typeof IntakeClassification>;
