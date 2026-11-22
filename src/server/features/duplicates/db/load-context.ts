import { and, between, eq, ne, or } from "drizzle-orm";
import type { Executor } from "@/server/db/client";
import { approvalPolicies, cardTransactions, documents, invoices, vendors } from "@/server/db/schema";
import { addDays, approvalThresholdsFromPolicyRows } from "@/server/features/validation";
import { DUPLICATE_CONFIG } from "../config";
import type { CardTxnRef, DuplicateContext, InvoiceOnRecord } from "../context";

/**
 * The duplicate context for ONE invoice, from Postgres, without scanning the history:
 *   invoices        this vendor's rows (index invoices_vendor_number_idx) + any row whose document
 *                   has the same sha256 (index documents_sha256_idx)
 *   card charges    only those for the same amount (CAD or invoice currency) in the date window
 *   vendors         id + name, only if a card charge needs its merchant matched
 * So the cost stays a few indexed lookups per invoice at 100× volume, not "compare with all".
 */

type InvoiceRow = {
  id: string;
  status: string;
  vendorId: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  receivedDate: string | null;
  currency: string | null;
  totalCents: number | null;
  totalCadCents: number | null;
  isCreditNote: boolean;
  createdAt: string;
  sha256: string | null;
};

const columns = {
  id: invoices.id,
  status: invoices.status,
  vendorId: invoices.vendorId,
  invoiceNumber: invoices.invoiceNumber,
  invoiceDate: invoices.invoiceDate,
  receivedDate: invoices.receivedDate,
  currency: invoices.currency,
  totalCents: invoices.totalCents,
  totalCadCents: invoices.totalCadCents,
  isCreditNote: invoices.isCreditNote,
  createdAt: invoices.createdAt,
  sha256: documents.sha256,
};

export function toRecord(r: InvoiceRow): InvoiceOnRecord {
  return {
    invoiceId: r.id,
    vendorId: r.vendorId,
    invoiceNumber: r.invoiceNumber,
    invoiceDate: r.invoiceDate,
    receivedDate: r.receivedDate,
    currency: r.currency,
    totalCents: r.totalCents,
    totalCadCents: r.totalCadCents,
    status: r.status,
    isCreditNote: r.isCreditNote,
    documentSha256: r.sha256,
    createdAt: r.createdAt,
  };
}

export async function loadInvoiceRecord(db: Executor, invoiceId: string): Promise<InvoiceOnRecord | null> {
  const [row] = await db.select(columns).from(invoices).leftJoin(documents, eq(documents.id, invoices.documentId)).where(eq(invoices.id, invoiceId));
  return row ? toRecord(row) : null;
}

export async function loadDuplicateContext(db: Executor, inv: InvoiceOnRecord): Promise<DuplicateContext> {
  const sameVendor = inv.vendorId ? eq(invoices.vendorId, inv.vendorId) : undefined;
  const sameFile = inv.documentSha256 ? eq(documents.sha256, inv.documentSha256) : undefined;
  const which = sameVendor && sameFile ? or(sameVendor, sameFile) : (sameVendor ?? sameFile);

  const priorRows: InvoiceRow[] = which
    ? await db
        .select(columns)
        .from(invoices)
        .leftJoin(documents, eq(documents.id, invoices.documentId))
        .where(and(which, ne(invoices.id, inv.invoiceId), ne(invoices.status, "Voided")))
    : [];

  let cards: CardTxnRef[] = [];
  const anchor = inv.invoiceDate ?? inv.receivedDate;
  if (inv.vendorId && anchor && inv.totalCents !== null && inv.totalCents > 0 && !inv.isCreditNote) {
    const amount = inv.totalCadCents !== null ? or(eq(cardTransactions.amountCents, inv.totalCents), eq(cardTransactions.amountCadCents, inv.totalCadCents)) : eq(cardTransactions.amountCents, inv.totalCents);
    const rows = await db
      .select()
      .from(cardTransactions)
      .where(and(amount, between(cardTransactions.postedDate, addDays(anchor, -DUPLICATE_CONFIG.cardDaysBefore), addDays(anchor, DUPLICATE_CONFIG.cardDaysAfter))));
    cards = rows.map((t) => ({
      id: t.id,
      postedDate: t.postedDate,
      merchantDescriptor: t.merchantDescriptor,
      amountCents: t.amountCents,
      currency: t.currency,
      amountCadCents: t.amountCadCents,
      source: t.source,
      cardholderId: t.cardholderId,
      vendorId: t.vendorId,
    }));
  }

  const needNames = cards.some((c) => !c.vendorId && !DUPLICATE_CONFIG.apPaymentCardSources.includes(c.source));
  const [vendorNames, thresholds] = await Promise.all([
    needNames ? db.select({ id: vendors.id, legalName: vendors.legalName }).from(vendors) : Promise.resolve([]),
    priorRows.length ? loadThresholds(db) : Promise.resolve([]),
  ]);

  return { invoices: priorRows.map(toRecord), cardTransactions: cards, vendors: vendorNames, approvalThresholdsCadCents: thresholds };
}

/** Approval amount tiers from the active policies: the same list validation's split check uses. */
async function loadThresholds(db: Executor): Promise<number[]> {
  const rows = await db
    .select({ ruleType: approvalPolicies.ruleType, conditions: approvalPolicies.conditions, steps: approvalPolicies.steps })
    .from(approvalPolicies)
    .where(eq(approvalPolicies.active, true));
  return approvalThresholdsFromPolicyRows(rows);
}

/** The whole picture at once (every invoice, every card charge), for the seed's history replay. */
export async function loadFullDuplicateContext(db: Executor): Promise<DuplicateContext> {
  const [rows, cards, vendorNames, thresholds] = await Promise.all([
    db.select(columns).from(invoices).leftJoin(documents, eq(documents.id, invoices.documentId)),
    db.select().from(cardTransactions),
    db.select({ id: vendors.id, legalName: vendors.legalName }).from(vendors),
    loadThresholds(db),
  ]);
  return {
    invoices: rows.map(toRecord),
    cardTransactions: cards.map((t) => ({ id: t.id, postedDate: t.postedDate, merchantDescriptor: t.merchantDescriptor, amountCents: t.amountCents, currency: t.currency, amountCadCents: t.amountCadCents, source: t.source, cardholderId: t.cardholderId, vendorId: t.vendorId })),
    vendors: vendorNames,
    approvalThresholdsCadCents: thresholds,
  };
}

