import { asc, desc, eq, sql } from "drizzle-orm";
import type { Actor } from "@/contracts/actor";
import { ApprovalPolicy } from "@/contracts/approvals";
import { recordDenied, withAction } from "@/server/core/audit";
import { authorize, Forbidden } from "@/server/core/authorize";
import { getDb, type Db, type Executor } from "@/server/db/client";
import { approvalPolicies, users } from "@/server/db/schema";

/**
 * The Admin's controls (Controller / CFO, `admin.edit`):
 *
 *   listPolicies()                          the current version of every approval policy
 *   updatePolicy(actor, id, patch)          an edit is a NEW version row (the old one stays, so each
 *                                           approval step still cites the exact rule it was routed by)
 *   setUserAvailability(actor, id, patch)   on leave + named delegate (policy P08), or back to active
 *
 * Every change: authorize → validate with the contract's guard rails → write → audit, one transaction.
 * Routing picks a new policy version up on the next submit; plans already routed keep theirs.
 */

export class AdminError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "AdminError";
  }
}

async function admin(actor: Actor, db: Db, attempted: string) {
  try {
    return authorize(actor, "admin.edit").actor;
  } catch (err) {
    if (err instanceof Forbidden) await recordDenied(actor, { attempted, reason: err.reason, entityType: "approval_policy", entityId: "-" }, { db });
    throw err;
  }
}

export async function listPolicies(db: Executor = getDb()): Promise<(ApprovalPolicy & { editedAt: string })[]> {
  const rows = await db.select().from(approvalPolicies).orderBy(asc(approvalPolicies.id), desc(approvalPolicies.version));
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!latest.has(r.id)) latest.set(r.id, r);
  return [...latest.values()].map((r) => ({
    ...ApprovalPolicy.parse({ id: r.id, version: r.version, active: r.active, ruleType: r.ruleType, priority: r.priority, conditions: r.conditions, steps: r.steps, description: r.description }),
    editedAt: new Date(r.createdAt).toISOString(),
  }));
}

export interface PolicyPatch {
  active?: boolean;
  /** For amount_up_to / amount_over conditions: the new threshold in CAD cents. */
  amountCadCents?: number;
  /** For vendor_new_or_pending: how many days a vendor counts as new. */
  newVendorDays?: number;
  description?: string;
  /** Why (required): shown in the audit trail. */
  note: string;
}

/** "$20,000" for whole dollars, "$20,000.50" otherwise: the style the policy file writes amounts in. */
function dollars(cents: number): string {
  const whole = Math.floor(cents / 100).toLocaleString("en-CA");
  return cents % 100 === 0 ? `$${whole}` : `$${whole}.${String(cents % 100).padStart(2, "0")}`;
}

/**
 * Keep an amount policy's description saying what the rule is. The seed reads the threshold from the
 * FIRST dollar amount of the policy's condition text (policies-from-csv.ts: "Invoice total up to $X",
 * "Payment over $X"), and that text opens the description, so we rewrite that same first amount to
 * the current threshold. Done on every save, so a description left stale by an older edit heals too.
 * Text without a dollar amount is left as is.
 */
export function restateThreshold(description: string, cadCents: number): string {
  return description.replace(/\$[\d,]+(?:\.\d+)?/, dollars(cadCents));
}

export async function updatePolicy(actor: Actor, policyId: string, patch: PolicyPatch, opts: { db?: Db } = {}): Promise<ApprovalPolicy> {
  const db = opts.db ?? getDb();
  const who = await admin(actor, db, "admin.edit (policy)");
  const note = patch.note?.trim();
  if (!note) throw new AdminError("Say why the policy is changing; the note goes into the audit trail.", 400);

  return withAction(
    who,
    async ({ tx, audit }) => {
      const [current] = await tx.select().from(approvalPolicies).where(eq(approvalPolicies.id, policyId)).orderBy(desc(approvalPolicies.version)).limit(1).for("update");
      if (!current) throw new AdminError(`Policy ${policyId} does not exist.`, 404);
      const before = ApprovalPolicy.parse({ id: current.id, version: current.version, active: current.active, ruleType: current.ruleType, priority: current.priority, conditions: current.conditions, steps: current.steps, description: current.description });

      let conditions = before.conditions;
      if (patch.amountCadCents !== undefined) {
        if (conditions.kind !== "amount_up_to" && conditions.kind !== "amount_over") throw new AdminError(`${policyId} is not keyed on an amount.`, 400);
        if (!Number.isSafeInteger(patch.amountCadCents) || patch.amountCadCents < 0) throw new AdminError("The amount must be a positive number of dollars.", 400);
        conditions = { ...conditions, cadCents: patch.amountCadCents };
      }
      if (patch.newVendorDays !== undefined) {
        if (conditions.kind !== "vendor_new_or_pending") throw new AdminError(`${policyId} is not about new vendors.`, 400);
        conditions = { ...conditions, newVendorDays: patch.newVendorDays };
      }
      const parsed = ApprovalPolicy.safeParse({
        ...before,
        version: before.version + 1,
        active: patch.active ?? before.active,
        conditions,
        description:
          patch.description?.trim() ||
          (conditions.kind === "amount_up_to" || conditions.kind === "amount_over" ? restateThreshold(before.description, conditions.cadCents) : before.description),
      });
      if (!parsed.success) throw new AdminError(parsed.error.issues.map((i) => i.message).join(" · "), 400);
      const next = parsed.data;
      if (JSON.stringify({ ...next, version: before.version }) === JSON.stringify(before)) throw new AdminError("Nothing changed.", 400);

      await tx.insert(approvalPolicies).values({
        id: next.id,
        version: next.version,
        active: next.active,
        ruleType: next.ruleType,
        priority: next.priority,
        conditions: next.conditions,
        steps: next.steps,
        description: next.description,
      });
      await audit({
        action: "policy.edited",
        entityType: "approval_policy",
        entityId: `${next.id}@v${next.version}`,
        before: { version: before.version, active: before.active, conditions: before.conditions, description: before.description },
        after: { version: next.version, active: next.active, conditions: next.conditions, description: next.description },
        reason: note,
      });
      return next;
    },
    { db },
  );
}

export interface AvailabilityPatch {
  status: "active" | "on_leave";
  /** Required when going on leave: who approves in their place (P08). */
  delegateId?: string | null;
  note: string;
}

export async function setUserAvailability(actor: Actor, userId: string, patch: AvailabilityPatch, opts: { db?: Db; today?: string } = {}) {
  const db = opts.db ?? getDb();
  const who = await admin(actor, db, "admin.edit (user availability)");
  const note = patch.note?.trim();
  if (!note) throw new AdminError("Add a note (e.g. the leave dates); it goes into the audit trail.", 400);
  const today = opts.today ?? new Date().toISOString().slice(0, 10);

  return withAction(
    who,
    async ({ tx, audit }) => {
      const [u] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
      if (!u || u.role === "system") throw new AdminError(`User ${userId} does not exist.`, 404);
      if (u.status === "terminated") throw new AdminError(`${u.fullName} has left the company.`, 409);
      let delegateId: string | null = null;
      if (patch.status === "on_leave") {
        if (!patch.delegateId) throw new AdminError("Pick who approves while they are away.", 400);
        if (patch.delegateId === userId) throw new AdminError("Someone cannot be their own delegate.", 400);
        const [d] = await tx.select().from(users).where(eq(users.id, patch.delegateId));
        if (!d || d.status !== "active") throw new AdminError("The delegate must be an active employee.", 400);
        delegateId = d.id;
      }
      const before = { status: u.status, statusSince: u.statusSince, delegateId: u.delegateId };
      const after = { status: patch.status, statusSince: today, delegateId: patch.status === "on_leave" ? delegateId : u.delegateId };
      if (before.status === after.status && before.delegateId === after.delegateId) throw new AdminError("Nothing changed.", 400);
      await tx.update(users).set({ status: after.status, statusSince: after.statusSince, delegateId: after.delegateId }).where(eq(users.id, userId));
      await audit({ action: "user.status_changed", entityType: "user", entityId: userId, before, after, reason: note });
      return { ...u, ...after };
    },
    { db },
  );
}

/** Everyone in the directory (not the system user), for the Admin's people screen. */
export async function listDirectory(db: Executor = getDb()) {
  return db
    .select()
    .from(users)
    .where(sql`${users.role} <> 'system'`)
    .orderBy(asc(users.id));
}
