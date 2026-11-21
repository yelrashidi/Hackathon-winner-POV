import { eq, sql } from "drizzle-orm";
import type { Actor } from "@/contracts/actor";
import { recordDenied, withAction } from "@/server/core/audit";
import { authorize, Forbidden } from "@/server/core/authorize";
import type { Db } from "@/server/db/client";
import { invoiceFlags } from "@/server/db/schema";

/**
 * A person closes an open flag (TODO 4: "override / resolve endpoint").
 *
 *   overrideFlag(actor, flagId, note)  accepted WITHOUT fixing the cause. A `block` flag stops
 *                                      blocking, but the condition is still true (contracts/flag.ts)
 *   resolveFlag(actor, flagId, note)   the cause was fixed (e.g. the PO was amended)
 *
 * Both: authorize → lock the row → must be open → note required → update → audit, in ONE
 * transaction. The note is also enforced by a CHECK constraint, so a code path that forgets
 * to ask still cannot save an override without a reason. A refused attempt is logged as
 * `authz.denied`.
 */

export class FlagActionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "FlagActionError";
  }
}

async function closeFlag(actor: Actor, flagId: number, note: string, decision: "overridden" | "resolved", opts: { db?: Db }) {
  const permission = decision === "overridden" ? "flag.override" : "flag.resolve";
  let who;
  try {
    who = authorize(actor, permission).actor;
  } catch (err) {
    if (err instanceof Forbidden) await recordDenied(actor, { attempted: permission, reason: err.reason, entityType: "invoice_flag", entityId: String(flagId) }, opts);
    throw err;
  }
  const trimmed = note.trim();
  if (!trimmed) throw new FlagActionError(decision === "overridden" ? "An override needs a note saying why it is acceptable." : "Say what was fixed.", 400);

  return withAction(
    who,
    async ({ tx, audit }) => {
      const [row] = await tx.select().from(invoiceFlags).where(eq(invoiceFlags.id, flagId)).for("update");
      if (!row) throw new FlagActionError(`Flag ${flagId} does not exist.`, 404);
      if (row.status !== "open") throw new FlagActionError(`This flag is already ${row.status}.`, 409);

      const [updated] = await tx
        .update(invoiceFlags)
        .set({ status: decision, resolvedBy: who.userId, resolvedAt: sql`now()`, resolutionNote: trimmed, updatedAt: sql`now()` })
        .where(eq(invoiceFlags.id, flagId))
        .returning();
      await audit({
        action: decision === "overridden" ? "flag.overridden" : "flag.resolved",
        entityType: "invoice_flag",
        entityId: String(flagId),
        invoiceId: row.invoiceId,
        before: { status: row.status, code: row.code, severity: row.severity, message: row.message },
        after: { status: updated!.status, resolvedBy: updated!.resolvedBy, resolutionNote: updated!.resolutionNote },
        reason: trimmed,
        metadata: { flagKey: row.flagKey, invoiceVersion: row.invoiceVersion },
      });
      return updated!;
    },
    opts,
  );
}

export function overrideFlag(actor: Actor, flagId: number, note: string, opts: { db?: Db } = {}) {
  return closeFlag(actor, flagId, note, "overridden", opts);
}

export function resolveFlag(actor: Actor, flagId: number, note: string, opts: { db?: Db } = {}) {
  return closeFlag(actor, flagId, note, "resolved", opts);
}
