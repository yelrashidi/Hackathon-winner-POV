import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Actor as ActorSchema, type Actor } from "@/contracts/actor";
import { AuditEventInput, type AuditEventInput as AuditEventInputType } from "@/contracts/audit";
import { getDb, type Db, type Tx } from "@/server/db/client";

/**
 * Feature 8 foundation — the audit emitter. The ONE way a row gets into `audit_events`.
 *
 *   withAction(actor, async ({ tx, audit }) => { …change rows…; await audit({...}) })
 *       Opens a transaction, gives it a request id, and hands you `audit()`. The change and its
 *       audit rows commit together or not at all (CLAUDE.md hard rule 3).
 *
 *   emit(tx, actor, requestId, event)
 *       The low-level insert. Takes a `Tx`, so it cannot be called outside a transaction.
 *
 * The INSERT names its columns explicitly and leaves out `id` and `occurred_at`: the app's DB role
 * is not allowed to write those (migration 0001), so the timestamp always comes from the database.
 */

export interface ActionContext {
  tx: Tx;
  actor: ReturnType<typeof ActorSchema.parse>;
  requestId: string;
  /** Write one audit event in this transaction, as this actor. */
  audit: (event: AuditEventInputType) => Promise<{ id: number; occurredAt: string }>;
}

const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));

export async function emit(tx: Tx, actor: Actor, requestId: string, event: AuditEventInputType): Promise<{ id: number; occurredAt: string }> {
  const a = ActorSchema.parse(actor);
  const e = AuditEventInput.parse(event);
  const result = await tx.execute<{ id: string | number; occurred_at: string | Date }>(sql`
    INSERT INTO audit_events
      (request_id, actor_id, actor_role, on_behalf_of, action, entity_type, entity_id,
       invoice_id, payment_id, before, after, reason, metadata)
    VALUES
      (${requestId}, ${a.userId}, ${a.role}, ${a.onBehalfOf}, ${e.action}, ${e.entityType}, ${e.entityId},
       ${e.invoiceId}, ${e.paymentId}, ${json(e.before)}::jsonb, ${json(e.after)}::jsonb, ${e.reason},
       ${json(e.metadata)}::jsonb)
    RETURNING id, occurred_at`);
  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { id: string | number; occurred_at: string | Date }[];
  const row = rows[0]!;
  return { id: Number(row.id), occurredAt: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at) };
}

/**
 * Runs `fn` in one transaction with an audit helper bound to the actor. Every mutating service
 * uses this. Throw to roll back everything, audit rows included.
 */
export async function withAction<T>(actor: Actor, fn: (ctx: ActionContext) => Promise<T>, opts: { db?: Db } = {}): Promise<T> {
  const parsed = ActorSchema.parse(actor);
  const db = opts.db ?? getDb();
  const requestId = randomUUID();
  return db.transaction(async (tx) => {
    const ctx: ActionContext = {
      tx,
      actor: parsed,
      requestId,
      audit: (event) => emit(tx, parsed, requestId, event),
    };
    return fn(ctx);
  });
}

/**
 * Records a refused attempt (authorize() said no). Written in its OWN short transaction, because
 * the request's transaction is rolled back. Never throws: failing to log a refusal must not turn
 * a clean 403 into a 500.
 */
export async function recordDenied(
  actor: Actor,
  details: { attempted: string; reason: string; entityType?: AuditEventInputType["entityType"]; entityId?: string; invoiceId?: string | null },
  opts: { db?: Db } = {},
): Promise<void> {
  try {
    await withAction(
      actor,
      ({ audit }) =>
        audit({
          action: "authz.denied",
          entityType: details.entityType ?? "invoice",
          entityId: details.entityId ?? details.invoiceId ?? "-",
          invoiceId: details.invoiceId ?? null,
          reason: details.reason,
          metadata: { attempted: details.attempted },
        }),
      opts,
    );
  } catch {
    // deliberately swallowed — see above
  }
}
