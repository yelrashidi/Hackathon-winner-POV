import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, type Db } from "@/server/db/client";
import { cardTransactions, invoiceFlags, invoices, vendors } from "@/server/db/schema";

/**
 * Read model for the duplicates dashboard: every OPEN duplicate flag, with both records side by
 * side (this invoice and the earlier invoice or the card charge it matches). Read only — the
 * page decides who may see it; every action goes through decide.ts, which authorizes again.
 *
 * Split facts ride on the duplicate card, not as cards of their own: the person deciding sees
 * "same bill?" and "if not, a possible split" together. They come from duplicates
 * (SPLIT_IF_NOT_DUPLICATE, same-number pairs) and from validation (SPLIT_INVOICE_SUSPECTED).
 */

/** Codes shown on a duplicate card as context, never as a card to decide on their own. */
export const SPLIT_CODES = ["SPLIT_IF_NOT_DUPLICATE", "SPLIT_INVOICE_SUSPECTED"] as const;

export interface SplitFact {
  flagId: number;
  code: string;
  /** duplicates | validation */
  source: string;
  message: string;
  relatedInvoiceId: string | null;
  combinedCadCents: number | null;
  thresholdCadCents: number | null;
}

export interface InvoiceSide {
  invoiceId: string;
  status: string;
  legacyStatus: string | null;
  source: string;
  vendorId: string | null;
  vendorName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  receivedDate: string | null;
  currency: string | null;
  totalCents: number | null;
  documentId: string | null;
}

export interface CardSide {
  id: string;
  postedDate: string;
  merchantDescriptor: string;
  amountCents: number;
  currency: string;
  cardholderId: string | null;
  source: string;
  memo: string | null;
}

export interface DuplicateReview {
  flagId: number;
  code: string;
  severity: string;
  message: string;
  evidence: Record<string, unknown>;
  raisedAt: string;
  invoice: InvoiceSide;
  related: InvoiceSide | null;
  card: CardSide | null;
  /** Open split flags on this invoice that involve the same related invoice (or any, from validation). */
  splitFacts: SplitFact[];
  /** Confirming moves the invoice through the state machine, which allows it only in review. */
  canConfirm: boolean;
  confirmLabel: string;
}

const invoiceCols = {
  invoiceId: invoices.id,
  status: invoices.status,
  legacyStatus: invoices.legacyStatus,
  source: invoices.source,
  vendorId: invoices.vendorId,
  vendorName: vendors.legalName,
  invoiceNumber: invoices.invoiceNumber,
  invoiceDate: invoices.invoiceDate,
  receivedDate: invoices.receivedDate,
  currency: invoices.currency,
  totalCents: invoices.totalCents,
  documentId: invoices.documentId,
};

export async function listDuplicateReviews(opts: { db?: Db } = {}): Promise<DuplicateReview[]> {
  const db = opts.db ?? getDb();
  const all = await db
    .select()
    .from(invoiceFlags)
    .where(and(eq(invoiceFlags.source, "duplicates"), eq(invoiceFlags.status, "open")))
    .orderBy(desc(invoiceFlags.raisedAt), desc(invoiceFlags.id));
  const isSplit = (code: string) => (SPLIT_CODES as readonly string[]).includes(code);
  const flags = all.filter((f) => !isSplit(f.code));
  if (!flags.length) return [];

  // Split facts for these invoices: duplicates' own notes + validation's split flags.
  const flaggedIds = [...new Set(flags.map((f) => f.invoiceId))];
  const validationSplits = await db
    .select()
    .from(invoiceFlags)
    .where(and(inArray(invoiceFlags.invoiceId, flaggedIds), eq(invoiceFlags.status, "open"), eq(invoiceFlags.code, "SPLIT_INVOICE_SUSPECTED"), eq(invoiceFlags.source, "validation")));
  const splits = [...all.filter((f) => isSplit(f.code)), ...validationSplits];

  const ids = [...new Set(flags.flatMap((f) => [f.invoiceId, f.relatedInvoiceId].filter((x): x is string => !!x)))];
  const cardIds = [...new Set(flags.map((f) => f.relatedCardTxnId).filter((x): x is string => !!x))];
  const [invRows, cardRows] = await Promise.all([
    db.select(invoiceCols).from(invoices).leftJoin(vendors, eq(vendors.id, invoices.vendorId)).where(inArray(invoices.id, ids)),
    cardIds.length ? db.select().from(cardTransactions).where(inArray(cardTransactions.id, cardIds)) : Promise.resolve([]),
  ]);
  const inv = new Map(invRows.map((r) => [r.invoiceId, r]));
  const card = new Map(cardRows.map((c) => [c.id, c]));

  return flags
    .filter((f) => inv.has(f.invoiceId))
    .map((f) => {
      const me = inv.get(f.invoiceId)!;
      const c = f.relatedCardTxnId ? card.get(f.relatedCardTxnId) : undefined;
      return {
        flagId: f.id,
        code: f.code,
        severity: f.severity,
        message: f.message,
        evidence: (f.evidence ?? {}) as Record<string, unknown>,
        raisedAt: f.raisedAt,
        invoice: me,
        related: f.relatedInvoiceId ? (inv.get(f.relatedInvoiceId) ?? null) : null,
        card: c
          ? { id: c.id, postedDate: c.postedDate, merchantDescriptor: c.merchantDescriptor, amountCents: c.amountCents, currency: c.currency, cardholderId: c.cardholderId, source: c.source, memo: c.memo }
          : null,
        splitFacts: splits
          .filter((s) => s.invoiceId === f.invoiceId && (s.source === "validation" || s.relatedInvoiceId === f.relatedInvoiceId))
          .map((s) => {
            const ev = (s.evidence ?? {}) as { combinedCadCents?: number; thresholdCadCents?: number };
            return {
              flagId: s.id,
              code: s.code,
              source: s.source,
              message: s.message,
              relatedInvoiceId: s.relatedInvoiceId,
              combinedCadCents: typeof ev.combinedCadCents === "number" ? ev.combinedCadCents : null,
              thresholdCadCents: typeof ev.thresholdCadCents === "number" ? ev.thresholdCadCents : null,
            };
          }),
        canConfirm: me.status === "InReview",
        confirmLabel: f.code === "ALREADY_PAID_BY_CARD" ? "Paid by card — close" : "Duplicate — void",
      };
    });
}
