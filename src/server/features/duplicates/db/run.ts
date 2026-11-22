import { eq } from "drizzle-orm";
import { SYSTEM_ACTOR } from "@/contracts/actor";
import { withAction, type ActionContext } from "@/server/core/audit";
import { getDb, type Db } from "@/server/db/client";
import { invoices } from "@/server/db/schema";
import { syncFlags, type PersistSummary } from "@/server/features/validation";
import type { DuplicateContext } from "../context";
import { checkDuplicates, type DuplicateResult } from "../engine";
import { loadDuplicateContext, loadInvoiceRecord } from "./load-context";

/**
 * The analysis pass's duplicates step against the database (runs right after validation, which
 * has just resolved the vendor and CAD total on the invoice row):
 *   load this invoice + its candidates → checkDuplicates (pure) → syncFlags(source "duplicates")
 *   → one `invoice.duplicates_checked` audit event with what it compared against.
 * Human decisions survive re-runs: an overridden "not a duplicate" flag stays overridden (syncFlags).
 *
 * Pass `ctx` to reuse a context already built (the seed replays all history with one).
 */
export async function checkDuplicatesWithin(
  action: ActionContext,
  invoiceId: string,
  opts: { ctx?: DuplicateContext; metadata?: Record<string, unknown> } = {},
): Promise<{ result: DuplicateResult; summary: PersistSummary }> {
  const { tx } = action;
  const [row] = await tx.select({ version: invoices.version }).from(invoices).where(eq(invoices.id, invoiceId));
  if (!row) throw new Error(`Invoice ${invoiceId} is not in the database; save it before checking duplicates.`);
  const inv = (await loadInvoiceRecord(tx, invoiceId))!;
  const ctx = opts.ctx ?? (await loadDuplicateContext(tx, inv));
  const result = checkDuplicates(inv, ctx);

  const summary = await syncFlags(action, { invoiceId, invoiceVersion: row.version, source: "duplicates", flags: result.flags });
  await action.audit({
    action: "invoice.duplicates_checked",
    entityType: "invoice",
    entityId: invoiceId,
    invoiceId,
    after: {
      invoiceVersion: row.version,
      vendorId: inv.vendorId,
      invoiceNumber: inv.invoiceNumber,
      totalCents: inv.totalCents,
      comparedInvoices: ctx.invoices.length,
      comparedCardTransactions: ctx.cardTransactions.length,
      flags: result.flags.map((f) => ({ code: f.code, severity: f.severity, relatedInvoiceId: f.relatedInvoiceId ?? null, relatedCardTxnId: f.relatedCardTxnId ?? null })),
    },
    metadata: { ...summary, ...opts.metadata },
  });
  return { result, summary };
}

/** As the `system` actor, in its own transaction (re-check on demand, e.g. before release). */
export async function checkDuplicatesAndPersist(invoiceId: string, opts: { db?: Db } = {}) {
  return withAction(SYSTEM_ACTOR, (action) => checkDuplicatesWithin(action, invoiceId), { db: opts.db ?? getDb() });
}
