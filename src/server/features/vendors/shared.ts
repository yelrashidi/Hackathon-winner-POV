import { and, desc, eq, inArray } from "drizzle-orm";
import type { Actor } from "@/contracts/actor";
import type { VendorReason, VendorStatus } from "@/contracts/vendor";
import { recordDenied, withAction, type ActionContext } from "@/server/core/audit";
import { authorize, Forbidden, type Action } from "@/server/core/authorize";
import type { Db, Executor } from "@/server/db/client";
import { auditEvents, users, vendorBankAccounts, vendors } from "@/server/db/schema";
import { checkActorActive, type Reason, type VendorState } from "./rules";

/**
 * Plumbing shared by the vendor services: the error type, the one way every write runs, and the
 * small loaders that turn rows (and the audit trail) into what the rules need.
 */

/** A refusal from the vendor rules: HTTP status + every reason, each with a stable code. */
export class VendorError extends Error {
  readonly status: 400 | 403 | 404 | 409;
  constructor(
    readonly reasons: VendorReason[],
    status?: 400 | 403 | 404 | 409,
  ) {
    super(reasons.map((r) => r.message).join(" "));
    this.name = "VendorError";
    this.status = status ?? 400;
  }
}

/** Throws when a rule said no. A person-rule (403) wins over a state problem (409) over bad input (400). */
export function refuseIf(reasons: readonly Reason[]): void {
  if (!reasons.length) return;
  const status = reasons.some((r) => r.status === 403) ? 403 : reasons.some((r) => r.status === 409) ? 409 : 400;
  throw new VendorError(reasons.map(({ code, message }) => ({ code, message })), status);
}

export const notFound = (vendorId: string) => new VendorError([{ code: "VENDOR_NOT_FOUND", message: `Vendor ${vendorId} does not exist.` }], 404);

export interface Me {
  id: string;
  fullName: string;
  status: string;
}

/**
 * Every vendor write, in this order (docs/rules/backend.md):
 *   1. authorize() by role — refused → `authz.denied` logged, Forbidden thrown
 *   2. one transaction: the actor must be an active user, then `fn` (rules → writes → audit)
 *   3. refused by a person-rule (403, e.g. "you entered it") → logged as `authz.denied` too,
 *      AFTER the rolled-back transaction (logging inside it would deadlock — BUG-Andrew-04)
 */
export async function vendorAction<T>(actor: Actor, action: Action, vendorId: string, db: Db, fn: (ctx: ActionContext, me: Me) => Promise<T>): Promise<T> {
  let who;
  try {
    who = authorize(actor, action).actor;
  } catch (err) {
    if (err instanceof Forbidden) await recordDenied(actor, { attempted: action, reason: err.reason, entityType: "vendor", entityId: vendorId }, { db });
    throw err;
  }
  try {
    return await withAction(
      who,
      async (ctx) => {
        const [me] = await ctx.tx.select({ id: users.id, fullName: users.fullName, status: users.status }).from(users).where(eq(users.id, who.userId));
        refuseIf(checkActorActive(me));
        return fn(ctx, me!);
      },
      { db },
    );
  } catch (err) {
    if (err instanceof VendorError && err.status === 403) {
      await recordDenied(who, { attempted: action, reason: err.message, entityType: "vendor", entityId: vendorId }, { db });
    }
    throw err;
  }
}

/** Read-side gate: `vendor.view`, refusal logged. */
export async function guardView(actor: Actor, db: Db, vendorId = "-") {
  try {
    return authorize(actor, "vendor.view").actor;
  } catch (err) {
    if (err instanceof Forbidden) await recordDenied(actor, { attempted: "vendor.view", reason: err.reason, entityType: "vendor", entityId: vendorId }, { db });
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// What the audit trail says about a vendor (who onboarded / approved it, why it has its status)
// ---------------------------------------------------------------------------------------------

type AuditRow = typeof auditEvents.$inferSelect;
const status = (o: unknown) => ((o as { status?: string } | null)?.status ?? null);

export interface VendorHistory {
  onboardedBy: string | null;
  onboardedOn: string | null;
  approvedBy: string | null;
  approvedOn: string | null;
  /** Reason on the latest status change. */
  statusReason: string | null;
  /** The status a vendor had right before its latest hold (to restore when the hold is lifted). */
  statusBeforeHold: VendorStatus | null;
}

/** Vendor events, newest first. Small: a vendor has a handful of status changes. */
export async function vendorHistory(db: Executor, vendorId: string): Promise<VendorHistory> {
  const rows: AuditRow[] = await db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.entityType, "vendor"), eq(auditEvents.entityId, vendorId), inArray(auditEvents.action, ["vendor.created", "vendor.status_changed"])))
    .orderBy(desc(auditEvents.id));
  const created = rows.find((r) => r.action === "vendor.created");
  const changes = rows.filter((r) => r.action === "vendor.status_changed");
  const approval = changes.find((r) => status(r.before) === "pending_review" && status(r.after) === "active");
  const lastHold = changes.find((r) => status(r.after) === "on_hold");
  const day = (r: AuditRow | undefined) => (r ? new Date(r.occurredAt).toISOString().slice(0, 10) : null);
  return {
    onboardedBy: created?.actorId ?? null,
    onboardedOn: day(created),
    approvedBy: approval?.actorId ?? null,
    approvedOn: day(approval),
    statusReason: changes[0]?.reason ?? null,
    statusBeforeHold: (status(lastHold?.before) as VendorStatus | null) ?? null,
  };
}

/** The vendor as the rules see it. `lock` = SELECT … FOR UPDATE, so two clicks cannot both act. */
export async function loadVendorState(db: Executor, vendorId: string, lock = false): Promise<(VendorState & { row: typeof vendors.$inferSelect; history: VendorHistory }) | null> {
  const q = db.select().from(vendors).where(eq(vendors.id, vendorId));
  const [row] = lock ? await q.for("update") : await q;
  if (!row) return null;
  const history = await vendorHistory(db, vendorId);
  return { id: row.id, legalName: row.legalName, status: row.status as VendorStatus, onboardedBy: history.onboardedBy, row, history };
}

export async function bankVersions(db: Executor, vendorId: string) {
  return db.select().from(vendorBankAccounts).where(eq(vendorBankAccounts.vendorId, vendorId)).orderBy(desc(vendorBankAccounts.version));
}

/** Bank-account audit entity id, the same convention payments uses: "V043#3". */
export const bankEntityId = (vendorId: string, version: number) => `${vendorId}#${version}`;

export const todayIso = () => new Date().toISOString().slice(0, 10);
