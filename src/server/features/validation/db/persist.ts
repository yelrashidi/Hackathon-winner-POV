import { and, eq, sql } from "drizzle-orm";
import { SYSTEM_USER_ID } from "@/contracts/actor";
import type { Flag } from "@/contracts/flag";
import type { ActionContext } from "@/server/core/audit";
import { invoiceFlags } from "@/server/db/schema";
import type { ValidationResult } from "../engine";
import { flagKey } from "../flag";

/**
 * Saves one validation run into `invoice_flags`, keeping every human decision.
 *
 * A flag's identity across runs is flagKey() = code|field|line. Comparing the new run with the
 * stored rows for this invoice:
 *   new key                     → insert                         audit flag.raised
 *   stored open, raised again   → refresh message / evidence     audit flag.raised (refreshed) if it changed
 *   stored resolved, raised     → back to open                   audit flag.reopened
 *   stored overridden, raised   → unchanged: a person accepted it, re-running does not undo that
 *   stored open, not raised     → resolved by `system`           audit flag.auto_resolved
 * Then one `invoice.validated` event records WHAT THE VERDICT WAS BASED ON (vendor match, contract,
 * FX rate, CAD total, flag codes, invoice version) — so "why was this allowed?" can be answered
 * months later, after the contract or the FX table has changed.
 *
 * Runs inside the caller's transaction (withAction), usually as the `system` actor.
 */

export interface PersistSummary {
  raised: number;
  refreshed: number;
  reopened: number;
  autoResolved: number;
  keptOverridden: number;
}

type FlagRow = typeof invoiceFlags.$inferSelect;

const snapshot = (r: Pick<FlagRow, "code" | "severity" | "message" | "evidence" | "status" | "resolvedBy" | "resolutionNote" | "invoiceVersion">) => ({
  code: r.code,
  severity: r.severity,
  message: r.message,
  evidence: r.evidence,
  status: r.status,
  resolvedBy: r.resolvedBy,
  resolutionNote: r.resolutionNote,
  invoiceVersion: r.invoiceVersion,
});

/** flagKey, made unique within one run: a rule that raises the same key twice keeps both flags. */
function keyed(flags: readonly Flag[]): Map<string, Flag> {
  const out = new Map<string, Flag>();
  for (const f of flags) {
    const base = flagKey(f);
    let key = base;
    for (let n = 2; out.has(key); n++) key = `${base}#${n}`;
    out.set(key, f);
  }
  return out;
}

/** Which stage raised the flags; each stage only ever syncs its own rows. */
export type FlagSource = "validation" | "duplicates" | "coding";

/**
 * The diff-and-save step for ANY stage's flags (validation, coding, duplicates): one stage's
 * fresh flags vs its stored rows for this invoice, with the rules in the header comment.
 */
export async function syncFlags(
  ctx: ActionContext,
  args: { invoiceId: string; invoiceVersion: number; source: FlagSource; flags: readonly Flag[] },
): Promise<PersistSummary> {
  const { tx } = ctx;
  const { invoiceId, invoiceVersion, source } = args;
  const summary: PersistSummary = { raised: 0, refreshed: 0, reopened: 0, autoResolved: 0, keptOverridden: 0 };

  const stored = await tx
    .select()
    .from(invoiceFlags)
    .where(and(eq(invoiceFlags.invoiceId, invoiceId), eq(invoiceFlags.source, source)))
    .for("update");
  const storedByKey = new Map(stored.map((r) => [r.flagKey, r]));
  const fresh = keyed(args.flags);

  for (const [key, f] of fresh) {
    const row = storedByKey.get(key);
    const values = {
      invoiceVersion,
      code: f.code,
      severity: f.severity,
      message: f.message,
      evidence: f.evidence,
      relatedInvoiceId: f.relatedInvoiceId ?? null,
      relatedCardTxnId: f.relatedCardTxnId ?? null,
    };

    if (!row) {
      const [inserted] = await tx
        .insert(invoiceFlags)
        .values({ invoiceId, source, flagKey: key, status: "open", ...values })
        .returning();
      await ctx.audit({ action: "flag.raised", entityType: "invoice_flag", entityId: String(inserted!.id), invoiceId, after: snapshot(inserted!), metadata: { source, flagKey: key, invoiceVersion } });
      summary.raised++;
      continue;
    }

    if (row.status === "overridden") {
      summary.keptOverridden++;
      continue;
    }

    if (row.status === "resolved") {
      const [updated] = await tx
        .update(invoiceFlags)
        .set({ ...values, status: "open", resolvedBy: null, resolvedAt: null, resolutionNote: null, updatedAt: sql`now()` })
        .where(eq(invoiceFlags.id, row.id))
        .returning();
      await ctx.audit({ action: "flag.reopened", entityType: "invoice_flag", entityId: String(row.id), invoiceId, before: snapshot(row), after: snapshot(updated!), metadata: { source, flagKey: key, invoiceVersion } });
      summary.reopened++;
      continue;
    }

    // open and raised again: refresh only if what it says changed.
    const changed = row.message !== f.message || row.severity !== f.severity || JSON.stringify(row.evidence) !== JSON.stringify(f.evidence) || row.invoiceVersion !== invoiceVersion;
    if (changed) {
      const [updated] = await tx.update(invoiceFlags).set({ ...values, updatedAt: sql`now()` }).where(eq(invoiceFlags.id, row.id)).returning();
      await ctx.audit({ action: "flag.raised", entityType: "invoice_flag", entityId: String(row.id), invoiceId, before: snapshot(row), after: snapshot(updated!), metadata: { source, flagKey: key, invoiceVersion, refreshed: true } });
      summary.refreshed++;
    }
  }

  for (const row of stored) {
    if (row.status !== "open" || fresh.has(row.flagKey)) continue;
    const note = `No longer raised when ${source} re-ran on invoice version ${invoiceVersion}.`;
    const [updated] = await tx
      .update(invoiceFlags)
      .set({ status: "resolved", resolvedBy: SYSTEM_USER_ID, resolvedAt: sql`now()`, resolutionNote: note, updatedAt: sql`now()` })
      .where(eq(invoiceFlags.id, row.id))
      .returning();
    await ctx.audit({ action: "flag.auto_resolved", entityType: "invoice_flag", entityId: String(row.id), invoiceId, before: snapshot(row), after: snapshot(updated!), reason: note, metadata: { source, flagKey: row.flagKey, invoiceVersion } });
    summary.autoResolved++;
  }
  return summary;
}

/** Validation's flags + the `invoice.validated` snapshot of what the verdict was based on. */
export async function persistFlags(
  ctx: ActionContext,
  args: { invoiceId: string; invoiceVersion: number; result: ValidationResult; metadata?: Record<string, unknown> },
): Promise<PersistSummary> {
  const { invoiceId, invoiceVersion, result } = args;
  const summary = await syncFlags(ctx, { invoiceId, invoiceVersion, source: "validation", flags: result.flags });
  await ctx.audit({
    action: "invoice.validated",
    entityType: "invoice",
    entityId: invoiceId,
    invoiceId,
    after: {
      invoiceVersion,
      vendorId: result.vendorId,
      vendorMatch: result.vendorMatch,
      deliveryProvince: result.deliveryProvince,
      contractId: result.contractId,
      fxRate: result.fxRate,
      totalCadCents: result.totalCadCents,
      blocking: result.blocking,
      flags: result.flags.map((f) => ({ code: f.code, severity: f.severity })),
    },
    metadata: { ...summary, ...args.metadata },
  });
  return summary;
}
