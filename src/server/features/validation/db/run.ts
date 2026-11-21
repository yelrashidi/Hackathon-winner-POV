import { eq, sql } from "drizzle-orm";
import { SYSTEM_ACTOR } from "@/contracts/actor";
import type { ValidationInput, ValidationInputDraft } from "@/contracts/validation";
import { withAction, type ActionContext } from "@/server/core/audit";
import { getDb, type Db } from "@/server/db/client";
import { invoices } from "@/server/db/schema";
import type { ValidationContext } from "../context";
import { validateInvoice, type ValidationResult } from "../engine";
import { loadDbContext } from "./load-context";
import { persistFlags, type PersistSummary } from "./persist";

/**
 * The analysis pass's validation step against the database:
 *   load context from Postgres → validateInvoice (pure) → save what it derived on the invoice row
 *   (vendor match, CAD total, FX rate, contract) → persistFlags + `invoice.validated`.
 * One transaction. Works for ANY invoice in the `invoices` table — nothing is tied to the dataset.
 *
 * Pass `ctx` to reuse a context you already built (the seed validates 400+ invoices with one).
 */

export interface RunOptions {
  today: string;
  db?: Db;
  ctx?: ValidationContext;
  metadata?: Record<string, unknown>;
}

/** Inside an open action (used by ingest, which also creates the invoice in the same transaction). */
export async function validateWithin(
  action: ActionContext,
  input: ValidationInputDraft | ValidationInput,
  opts: Omit<RunOptions, "db">,
): Promise<{ result: ValidationResult; summary: PersistSummary }> {
  const { tx } = action;
  const [inv] = await tx
    .select({ version: invoices.version, vendorId: invoices.vendorId, totalCadCents: invoices.totalCadCents, fxRate: invoices.fxRate, contractId: invoices.contractId, source: invoices.source })
    .from(invoices)
    .where(eq(invoices.id, input.invoiceId))
    .for("update");
  if (!inv) throw new Error(`Invoice ${input.invoiceId} is not in the database; save it before validating.`);

  const ctx = opts.ctx ?? (await loadDbContext(tx, { today: opts.today, excludeInvoiceId: input.invoiceId }));
  const result = validateInvoice(input, ctx);

  // Historical rows already carry the source system's values; new invoices get validation's.
  if (inv.source !== "historical") {
    const derived = {
      vendorId: result.vendorId,
      totalCadCents: result.totalCadCents,
      fxRate: result.fxRate ?? (result.totalCadCents !== null ? "1" : null),
      contractId: result.contractId,
    };
    const before = { vendorId: inv.vendorId, totalCadCents: inv.totalCadCents, fxRate: inv.fxRate, contractId: inv.contractId };
    if (JSON.stringify(before) !== JSON.stringify(derived)) {
      await tx.update(invoices).set({ ...derived, updatedAt: sql`now()` }).where(eq(invoices.id, input.invoiceId));
      await action.audit({
        action: "invoice.edited",
        entityType: "invoice",
        entityId: input.invoiceId,
        invoiceId: input.invoiceId,
        before,
        after: derived,
        reason: "Filled in by validation (vendor match, FX conversion, contract)",
        metadata: { invoiceVersion: inv.version, by: "validation" },
      });
    }
  }

  const summary = await persistFlags(action, { invoiceId: input.invoiceId, invoiceVersion: inv.version, result, metadata: opts.metadata });
  return { result, summary };
}

/** As the `system` actor, in its own transaction. */
export async function validateAndPersist(input: ValidationInputDraft | ValidationInput, opts: RunOptions): Promise<{ result: ValidationResult; summary: PersistSummary }> {
  return withAction(SYSTEM_ACTOR, (action) => validateWithin(action, input, opts), { db: opts.db ?? getDb() });
}
