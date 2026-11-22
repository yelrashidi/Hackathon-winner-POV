import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Actor } from "@/contracts/actor";
import { ApprovalPolicy } from "@/contracts/approvals";
import { recordDenied, withAction } from "@/server/core/audit";
import { authorize, Forbidden } from "@/server/core/authorize";
import { getDb, type Db, type Executor } from "@/server/db/client";
import { approvalPolicies, auditEvents, users, vendors } from "@/server/db/schema";

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
        description: patch.description?.trim() || before.description,
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

// ---------------------------------------------------------------------------------------------
// Vendor master (feature 9): onboard a vendor, approve / hold it
// ---------------------------------------------------------------------------------------------

export interface NewVendor {
  legalName: string;
  category: string;
  provinceOrState?: string | null;
  country?: string | null;
  gstHstNumber?: string | null;
  apContactEmail?: string | null;
  paymentTermsDays?: number | null;
  requiresPo?: boolean;
}

/**
 * Onboard a vendor. It starts as `pending_review`: invoices from it can be checked, but approvals adds
 * the Finance Manager step (policy P05) and payments won't pay it until someone else approves it.
 * Anyone who may request bank changes may onboard (clerk, Finance Manager, Admin).
 */
export async function createVendor(actor: Actor, v: NewVendor, opts: { db?: Db; today?: string } = {}) {
  const db = opts.db ?? getDb();
  let who;
  try {
    who = authorize(actor, "vendor.bank_change.request").actor;
  } catch (err) {
    if (err instanceof Forbidden) await recordDenied(actor, { attempted: "vendor.create", reason: err.reason, entityType: "vendor", entityId: "-" }, { db });
    throw err;
  }
  const legalName = v.legalName?.trim();
  const category = v.category?.trim();
  if (!legalName || !category) throw new AdminError("A vendor needs a legal name and a category.", 400);
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  return withAction(
    who,
    async ({ tx, audit }) => {
      const [dupe] = await tx.select({ id: vendors.id }).from(vendors).where(sql`lower(${vendors.legalName}) = lower(${legalName})`);
      if (dupe) throw new AdminError(`${legalName} is already in the vendor master (${dupe.id}).`, 409);
      const [{ n }] = (await tx.select({ n: sql<number>`count(*)::int` }).from(vendors)) as [{ n: number }];
      let id = `V${String(Number(n) + 1).padStart(3, "0")}`;
      for (let k = Number(n) + 2; (await tx.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, id))).length; k++) id = `V${String(k).padStart(3, "0")}`;
      const row = {
        id,
        legalName,
        category,
        provinceOrState: v.provinceOrState?.trim() || null,
        country: v.country?.trim() || "CA",
        gstHstNumber: v.gstHstNumber?.trim() || null,
        apContactEmail: v.apContactEmail?.trim() || null,
        paymentTermsDays: v.paymentTermsDays ?? 30,
        requiresPo: v.requiresPo ?? false,
        status: "pending_review",
        onboardedAt: today,
      };
      await tx.insert(vendors).values(row);
      await audit({ action: "vendor.created", entityType: "vendor", entityId: id, after: row, reason: "Onboarded in the app; pending review by a second person." });
      return row;
    },
    { db },
  );
}

/** Approve a pending vendor, put one on hold, or release a hold. A second person (not who onboarded it) approves. */
export async function setVendorStatus(actor: Actor, vendorId: string, status: "active" | "on_hold" | "pending_review", note: string, opts: { db?: Db } = {}) {
  const db = opts.db ?? getDb();
  let who;
  try {
    who = authorize(actor, "vendor.bank_change.verify").actor;
  } catch (err) {
    if (err instanceof Forbidden) await recordDenied(actor, { attempted: "vendor.status", reason: err.reason, entityType: "vendor", entityId: vendorId }, { db });
    throw err;
  }
  const reason = note?.trim();
  if (!reason) throw new AdminError("Say why; the note goes into the audit trail.", 400);
  return withAction(
    who,
    async ({ tx, audit }) => {
      const [v] = await tx.select().from(vendors).where(eq(vendors.id, vendorId)).for("update");
      if (!v) throw new AdminError(`Vendor ${vendorId} does not exist.`, 404);
      if (v.status === status) throw new AdminError(`${v.legalName} is already ${status.replace("_", " ")}.`, 409);
      if (v.status === "pending_review" && status === "active") {
        const [created] = await tx
          .select({ actorId: auditEvents.actorId })
          .from(auditEvents)
          .where(and(eq(auditEvents.action, "vendor.created"), eq(auditEvents.entityId, vendorId)));
        if (created?.actorId === who.userId) throw new AdminError("You onboarded this vendor, so someone else must approve it (two people).", 409);
      }
      await tx.update(vendors).set({ status }).where(eq(vendors.id, vendorId));
      await audit({ action: "vendor.status_changed", entityType: "vendor", entityId: vendorId, before: { status: v.status }, after: { status }, reason });
      return { vendorId, status };
    },
    { db },
  );
}
