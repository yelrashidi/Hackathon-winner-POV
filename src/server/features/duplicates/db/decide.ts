import { and, eq, sql } from "drizzle-orm";
import type { Actor } from "@/contracts/actor";
import { recordDenied, withAction } from "@/server/core/audit";
import { authorize, Forbidden } from "@/server/core/authorize";
import { fire } from "@/server/core/fire";
import { getDb, type Db } from "@/server/db/client";
import { invoiceFlags, invoices } from "@/server/db/schema";
import { overrideFlag } from "@/server/features/validation";

/**
 * A person decides a duplicate flag on the duplicates dashboard. Nothing is decided by the system.
 *
 *   confirmDuplicate(actor, flagId, note)  "Yes, it is the same bill." The invoice leaves the
 *        queue through the state machine — never deleted, so the audit trail keeps both copies:
 *          ALREADY_PAID_BY_CARD → confirmPaidByCard → Closed
 *          any other code       → confirmDuplicate  → Voided
 *        This flag is resolved with the note; the invoice's other open duplicate flags are
 *        resolved as "closed with it". One transaction.
 *   dismissDuplicate(actor, flagId, note)  "No, it is a different bill." The flag is overridden
 *        with the note (validation's overrideFlag), so it stops blocking submit, and stays
 *        overridden on every re-run.
 *
 * Both: authorize() on the server (AP clerk or controller), note required, refusal logged.
 */

export class DuplicateActionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "DuplicateActionError";
  }
}

async function authorized(actor: Actor, flagId: number, db: Db, permission: "invoice.review" | "flag.override") {
  try {
    return authorize(actor, permission).actor;
  } catch (err) {
    if (err instanceof Forbidden) await recordDenied(actor, { attempted: permission, reason: err.reason, entityType: "invoice_flag", entityId: String(flagId) }, { db });
    throw err;
  }
}

export async function confirmDuplicate(actor: Actor, flagId: number, note: string, opts: { db?: Db } = {}) {
  const db = opts.db ?? getDb();
  const who = await authorized(actor, flagId, db, "invoice.review");
  const reason = note.trim();
  if (!reason) throw new DuplicateActionError("Say why this is the same bill (e.g. which copy is kept).", 400);

  return withAction(
    who,
    async (action) => {
      const { tx } = action;
      const [row] = await tx.select().from(invoiceFlags).where(eq(invoiceFlags.id, flagId)).for("update");
      if (!row || row.source !== "duplicates") throw new DuplicateActionError(`Duplicate flag ${flagId} does not exist.`, 404);
      if (row.status !== "open") throw new DuplicateActionError(`This flag is already ${row.status}.`, 409);
      const [inv] = await tx.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, row.invoiceId));
      if (inv?.status !== "InReview") {
        throw new DuplicateActionError(
          `Invoice ${row.invoiceId} is ${inv?.status ?? "missing"}; a duplicate can only be confirmed while it is in review. Its open block flag still stops payment release.`,
          409,
        );
      }

      const open = await tx
        .select()
        .from(invoiceFlags)
        .where(and(eq(invoiceFlags.invoiceId, row.invoiceId), eq(invoiceFlags.source, "duplicates"), eq(invoiceFlags.status, "open")))
        .for("update");
      for (const f of open) {
        const resolutionNote = f.id === flagId ? `Confirmed duplicate: ${reason}` : `Closed with the invoice when duplicate flag ${flagId} was confirmed.`;
        await tx.update(invoiceFlags).set({ status: "resolved", resolvedBy: who.userId, resolvedAt: sql`now()`, resolutionNote, updatedAt: sql`now()` }).where(eq(invoiceFlags.id, f.id));
        await action.audit({
          action: "flag.resolved",
          entityType: "invoice_flag",
          entityId: String(f.id),
          invoiceId: f.invoiceId,
          before: { status: f.status, code: f.code, severity: f.severity, message: f.message },
          after: { status: "resolved", resolvedBy: who.userId, resolutionNote },
          reason: resolutionNote,
          metadata: { flagKey: f.flagKey, source: "duplicates", decision: "confirmed_duplicate" },
        });
      }

      const event = row.code === "ALREADY_PAID_BY_CARD" ? "confirmPaidByCard" : "confirmDuplicate";
      const moved = await fire(action, row.invoiceId, event, {
        reason,
        metadata: { flagId, code: row.code, relatedInvoiceId: row.relatedInvoiceId, relatedCardTxnId: row.relatedCardTxnId },
      });
      return { invoiceId: row.invoiceId, status: moved.to, resolvedFlags: open.length };
    },
    { db },
  );
}

export async function dismissDuplicate(actor: Actor, flagId: number, note: string, opts: { db?: Db } = {}) {
  const db = opts.db ?? getDb();
  await authorized(actor, flagId, db, "flag.override");
  if (!note.trim()) throw new DuplicateActionError("Say why this is a different bill (e.g. a separate order).", 400);
  const [row] = await db.select({ source: invoiceFlags.source }).from(invoiceFlags).where(eq(invoiceFlags.id, flagId));
  if (!row || row.source !== "duplicates") throw new DuplicateActionError(`Duplicate flag ${flagId} does not exist.`, 404);
  return overrideFlag(actor, flagId, `Not a duplicate: ${note.trim()}`, { db });
}
