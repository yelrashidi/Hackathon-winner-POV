import { and, asc, desc, eq, gte, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import type { Actor } from "@/contracts/actor";
import { ApprovalPolicy, type ApprovalInput, type ApprovalPlan } from "@/contracts/approvals";
import type { Flag } from "@/contracts/flag";
import { emit, recordDenied, withAction } from "@/server/core/audit";
import { authorize, Forbidden } from "@/server/core/authorize";
import { fire } from "@/server/core/fire";
import { getDb, type Db, type Executor } from "@/server/db/client";
import { vendorConflicts } from "@/server/features/vendors/conflicts";
import { approvalPlans, approvalPolicies, approvalSteps, departments, invoiceFlags, invoiceLines, invoices, purchaseOrders, users, vendors } from "@/server/db/schema";
import {
  applyDecision,
  checkDecision,
  getApprovalPlans,
  getCurrentApprovalPlan,
  planApprovals,
  saveApprovalPlan,
  saveDecision,
  type ApprovalContext,
  type ApprovalPlanRow,
  type ApprovalStepRow,
  type ApprovalStore,
  type DirectoryUser,
  type InvoiceRef,
  type UserRole,
} from "@/server/features/approvals";

/**
 * Feature 6 (approvals, Youssef's pure engine + store API) on the database.
 *
 *   PostgresApprovalStore(tx)          the four queries ApprovalStore asks for, on approval_plans / approval_steps
 *   loadApprovalContext(db, asOf)      users, departments, vendors, policies from the tables
 *   submitForApproval(actor, id)       InReview → plan → PendingApproval (or OnHold), one transaction
 *   decideApproval(actor, id, body)    approve / reject the current step → fire stepApproved / stepRejected
 *
 * Every write happens in ONE transaction with its audit rows and fire(), exactly the flow written
 * at the top of features/approvals/store.ts. The store is passed explicitly ({ store }) — the
 * app-wide default store is left alone, so payments' in-memory flow keeps working unchanged.
 */

const iso = (v: string | null) => (v === null ? null : new Date(v).toISOString());

export class PostgresApprovalStore implements ApprovalStore {
  constructor(private readonly db: Executor) {}

  async insertPlan(plan: ApprovalPlanRow, steps: readonly ApprovalStepRow[]): Promise<void> {
    await this.db.insert(approvalPlans).values({
      id: plan.planId,
      invoiceId: plan.invoiceId,
      invoiceVersion: plan.invoiceVersion,
      attempt: plan.attempt,
      departmentId: plan.departmentId,
      outcome: plan.outcome,
      routingCadCents: plan.routingCadCents,
      basis: plan.basis,
      excludedApprovers: plan.excludedApprovers,
      attention: plan.attention,
      holdReasons: plan.holdReasons,
      notes: plan.notes,
      routedAt: plan.routedAt,
    });
    if (steps.length) await this.db.insert(approvalSteps).values(steps.map(stepValues));
  }

  async listPlans(invoiceId: string): Promise<ApprovalPlanRow[]> {
    const rows = await this.db.select().from(approvalPlans).where(eq(approvalPlans.invoiceId, invoiceId)).orderBy(asc(approvalPlans.attempt));
    return rows.map((r) => ({
      planId: r.id,
      attempt: r.attempt,
      invoiceId: r.invoiceId,
      invoiceVersion: r.invoiceVersion,
      departmentId: r.departmentId ?? "",
      routedAt: iso(r.routedAt)!,
      outcome: r.outcome as ApprovalPlanRow["outcome"],
      routingCadCents: r.routingCadCents,
      basis: r.basis as ApprovalPlanRow["basis"],
      excludedApprovers: r.excludedApprovers as ApprovalPlanRow["excludedApprovers"],
      attention: r.attention as ApprovalPlanRow["attention"],
      holdReasons: r.holdReasons as ApprovalPlanRow["holdReasons"],
      notes: r.notes as ApprovalPlanRow["notes"],
    }));
  }

  async listSteps(invoiceId: string): Promise<ApprovalStepRow[]> {
    const rows = await this.db.select().from(approvalSteps).where(eq(approvalSteps.invoiceId, invoiceId)).orderBy(asc(approvalSteps.planId), asc(approvalSteps.seq));
    return rows.map((r) => ({
      planId: r.planId,
      invoiceId: r.invoiceId,
      invoiceVersion: r.invoiceVersion,
      seq: r.seq,
      role: r.role as ApprovalStepRow["role"],
      alsoCovers: r.alsoCovers as ApprovalStepRow["alsoCovers"],
      policyId: r.policyId,
      policyVersion: r.policyVersion,
      reasons: r.reasons as ApprovalStepRow["reasons"],
      routedTo: r.routedTo ?? "",
      assignedTo: r.assignedTo ?? "",
      onBehalfOf: r.onBehalfOf,
      resolution: r.resolution as ApprovalStepRow["resolution"],
      decision: r.decision as ApprovalStepRow["decision"],
      actedBy: r.actedBy,
      actedAs: r.actedAs as ApprovalStepRow["actedAs"],
      acknowledgedFlags: r.acknowledgedFlags as string[],
      comment: r.comment,
      decidedAt: iso(r.decidedAt),
    }));
  }

  /** The conditional write: only a still-pending step changes, so the second of two clicks loses. */
  async updatePendingStep(planId: string, seq: number, decided: ApprovalStepRow): Promise<boolean> {
    const v = stepValues(decided);
    const changed = await this.db
      .update(approvalSteps)
      .set({
        alsoCovers: v.alsoCovers,
        policyId: v.policyId,
        policyVersion: v.policyVersion,
        reasons: v.reasons,
        routedTo: v.routedTo,
        assignedTo: v.assignedTo,
        onBehalfOf: v.onBehalfOf,
        resolution: v.resolution,
        decision: v.decision,
        actedBy: v.actedBy,
        actedAs: v.actedAs,
        acknowledgedFlags: v.acknowledgedFlags,
        comment: v.comment,
        decidedAt: v.decidedAt,
      })
      .where(and(eq(approvalSteps.planId, planId), eq(approvalSteps.seq, seq), eq(approvalSteps.decision, "pending")))
      .returning({ id: approvalSteps.id });
    return changed.length > 0;
  }
}

function stepValues(s: ApprovalStepRow) {
  return {
    planId: s.planId,
    invoiceId: s.invoiceId,
    invoiceVersion: s.invoiceVersion,
    seq: s.seq,
    role: s.role,
    alsoCovers: s.alsoCovers,
    policyId: s.policyId,
    policyVersion: s.policyVersion,
    reasons: s.reasons,
    routedTo: s.routedTo || null,
    assignedTo: s.assignedTo || null,
    onBehalfOf: s.onBehalfOf,
    resolution: s.resolution,
    decision: s.decision,
    actedBy: s.actedBy,
    actedAs: s.actedAs,
    acknowledgedFlags: s.acknowledgedFlags,
    comment: s.comment,
    decidedAt: s.decidedAt,
  };
}

export async function loadApprovalContext(db: Executor, asOf: Date): Promise<ApprovalContext> {
  const [u, d, v, p] = await Promise.all([
    db.select().from(users).where(ne(users.role, "system")),
    db.select().from(departments),
    db.select().from(vendors),
    db.select().from(approvalPolicies).orderBy(asc(approvalPolicies.id), desc(approvalPolicies.version)),
  ]);
  const latest = new Map<string, (typeof p)[number]>();
  for (const row of p) if (!latest.has(row.id)) latest.set(row.id, row);
  return {
    users: new Map<string, DirectoryUser>(
      u.map((x) => [
        x.id,
        {
          id: x.id,
          fullName: x.fullName,
          role: x.role as UserRole,
          departmentId: x.departmentId ?? "",
          managerId: x.managerId,
          approvalLimitCents: x.approvalLimitCents,
          status: x.status,
          statusSince: x.statusSince,
          delegateId: x.delegateId,
        },
      ]),
    ),
    departments: new Map(d.map((x) => [x.id, { id: x.id, name: x.name, managerId: x.managerId ?? "", annualBudgetCents: x.annualBudgetCents }])),
    vendors: new Map(v.map((x) => [x.id, { id: x.id, legalName: x.legalName, category: x.category, status: x.status, requiresPo: x.requiresPo, onboardedAt: x.onboardedAt }])),
    policies: [...latest.values()].map((r) =>
      ApprovalPolicy.parse({ id: r.id, version: r.version, active: r.active, ruleType: r.ruleType, priority: r.priority, conditions: r.conditions, steps: r.steps, description: r.description }),
    ),
    asOf,
  };
}

export class ApprovalFlowError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409,
    readonly code?: string,
    readonly reasons: string[] = [],
  ) {
    super(message);
    this.name = "ApprovalFlowError";
  }
}

const APPROVED_SPEND = ["Approved", "PaymentScheduled", "Paid", "Closed"];

async function storedFlags(db: Executor, invoiceId: string): Promise<Flag[]> {
  const rows = await db.select().from(invoiceFlags).where(eq(invoiceFlags.invoiceId, invoiceId)).orderBy(asc(invoiceFlags.id));
  return rows.map((f) => ({
    code: f.code,
    severity: f.severity as Flag["severity"],
    message: f.message,
    evidence: (f.evidence ?? {}) as Record<string, unknown>,
    ...(f.relatedInvoiceId ? { relatedInvoiceId: f.relatedInvoiceId } : {}),
    ...(f.relatedCardTxnId ? { relatedCardTxnId: f.relatedCardTxnId } : {}),
    status: f.status as Flag["status"],
    resolvedBy: f.resolvedBy,
    resolutionNote: f.resolutionNote,
  }));
}

/**
 * Submit an invoice in review for approval. Routes it with planApprovals() on the stored flags
 * (validation + coding + duplicates), saves the plan, and fires `submit` (→ PendingApproval) or
 * `hold` (→ OnHold). A "blocked" plan (open blocking flags, unconfirmed coding) is not saved and
 * comes back as a 409 with every reason.
 */
export async function submitForApproval(actor: Actor, invoiceId: string, opts: { db?: Db; now?: Date } = {}): Promise<ApprovalPlan> {
  const db = opts.db ?? getDb();
  let who;
  try {
    who = authorize(actor, "invoice.submit").actor;
  } catch (err) {
    if (err instanceof Forbidden) await recordDenied(actor, { attempted: "invoice.submit", reason: err.reason, invoiceId }, { db });
    throw err;
  }
  const now = opts.now ?? new Date();

  return withAction(
    who,
    async (action) => {
      const { tx } = action;
      const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for("update");
      if (!inv) throw new ApprovalFlowError(`Invoice ${invoiceId} does not exist.`, 404);
      if (inv.status !== "InReview") throw new ApprovalFlowError(`Only an invoice in review can be submitted (it is ${inv.status}).`, 409);
      const missing = [
        !inv.requesterId && "the requester",
        !inv.departmentId && "the requesting department",
        !inv.currency && "the currency",
        inv.totalCents === null && "the total",
        inv.totalCadCents === null && "the CAD total (needs an FX rate)",
      ].filter(Boolean);
      if (missing.length) throw new ApprovalFlowError(`Set ${missing.join(", ")} before submitting — approvals routes on them.`, 409, "MISSING_FIELDS");

      const year = (inv.invoiceDate ?? now.toISOString()).slice(0, 4);
      const [[po], lineDepts, [ytd], flags] = await Promise.all([
        inv.poId ? tx.select({ requesterId: purchaseOrders.requesterId }).from(purchaseOrders).where(eq(purchaseOrders.id, inv.poId)) : Promise.resolve([undefined]),
        tx.selectDistinct({ d: invoiceLines.departmentId }).from(invoiceLines).where(and(eq(invoiceLines.invoiceId, invoiceId), isNotNull(invoiceLines.departmentId))),
        tx
          .select({ n: sql<string | null>`sum(${invoices.totalCadCents})::text` })
          .from(invoices)
          .where(
            and(
              eq(invoices.departmentId, inv.departmentId!),
              ne(invoices.id, invoiceId),
              inArray(invoices.status, APPROVED_SPEND),
              gte(invoices.invoiceDate, `${year}-01-01`),
              lt(invoices.invoiceDate, `${Number(year) + 1}-01-01`),
            ),
          ),
        storedFlags(tx, invoiceId),
      ]);

      const input: ApprovalInput = {
        invoiceId,
        invoiceVersion: inv.version,
        vendorId: inv.vendorId,
        vendorNameRaw: inv.vendorNameRaw ?? "",
        departmentId: inv.departmentId!,
        requesterId: inv.requesterId!,
        submittedBy: who.userId !== inv.requesterId ? who.userId : null,
        poId: inv.poId,
        poRequesterId: po?.requesterId ?? null,
        // Feature 9: who maintains this vendor (onboarded it, changed its bank) may not approve it.
        conflicts: await vendorConflicts(tx, inv.vendorId),
        currency: inv.currency!,
        totalCents: inv.totalCents!,
        fxRateToCad: Number(inv.fxRate ?? "1"), // a rate (decimal), as the approvals contract takes it
        totalCadCents: inv.totalCadCents!,
        lineDepartmentIds: lineDepts.map((x) => x.d!),
        departmentSpendYtdCadCents: ytd?.n ? Number(ytd.n) : 0,
        flags,
      };

      const store = new PostgresApprovalStore(tx);
      const ctx = await loadApprovalContext(tx, now);
      const history = await getApprovalPlans(invoiceId, { store });
      const plan = planApprovals(input, ctx, history);
      if (plan.outcome === "blocked") {
        throw new ApprovalFlowError(
          `This invoice cannot go to approval yet: ${plan.holdReasons.map((r) => r.message).join(" · ")}`,
          409,
          "BLOCKED",
          plan.holdReasons.map((r) => r.message),
        );
      }
      await saveApprovalPlan(plan, { store });
      const saved = (await getCurrentApprovalPlan(invoiceId, { invoiceVersion: inv.version, store }))!;
      await action.audit({
        action: "approval.routed",
        entityType: "approval_plan",
        entityId: saved.planId!,
        invoiceId,
        after: {
          outcome: saved.outcome,
          steps: saved.steps.length,
          route: saved.steps.map((s) => ({ seq: s.seq, role: s.role, assignedTo: s.assignedTo, onBehalfOf: s.onBehalfOf, policyId: s.policyId })),
          routingCadCents: saved.routingCadCents,
          holdReasons: saved.holdReasons.map((r) => r.message),
        },
        metadata: { invoiceVersion: inv.version },
      });
      await fire(action, invoiceId, saved.outcome === "hold" ? "hold" : "submit", { reason: saved.outcome === "hold" ? saved.holdReasons.map((r) => r.message).join(" · ") : undefined });
      return saved;
    },
    { db },
  );
}

/**
 * Approve or reject the current step (body: { action: "approve" | "reject", comment?, acknowledgedFlags? }).
 * checkDecision() decides who may act (delegation, escalation, separation of duties); the audit
 * row records the real actor AND on_behalf_of for a delegate.
 */
export async function decideApproval(actor: Actor, invoiceId: string, body: unknown, opts: { db?: Db; now?: Date } = {}) {
  const db = opts.db ?? getDb();
  let who;
  try {
    who = authorize(actor, "approval.decide").actor;
  } catch (err) {
    if (err instanceof Forbidden) await recordDenied(actor, { attempted: "approval.decide", reason: err.reason, invoiceId }, { db });
    throw err;
  }
  const now = opts.now ?? new Date();

  const outcome = await withAction(
    who,
    async (action) => {
      const { tx } = action;
      const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for("update");
      if (!inv) throw new ApprovalFlowError(`Invoice ${invoiceId} does not exist.`, 404);
      const store = new PostgresApprovalStore(tx);
      const plan = await getCurrentApprovalPlan(invoiceId, { invoiceVersion: inv.version, store });
      if (!plan) throw new ApprovalFlowError("This invoice has no approval plan for its current version; submit it first.", 409);

      const ref: InvoiceRef = { invoiceId, invoiceVersion: inv.version, status: inv.status, requesterId: inv.requesterId ?? "", submittedBy: null, vendorId: inv.vendorId };
      const ctx = await loadApprovalContext(tx, now);
      const check = checkDecision(plan, ref, who.userId, body, ctx);
      if (!check.ok) return { denied: check } as const;

      const result = applyDecision(plan, check, now);
      await saveDecision(invoiceId, inv.version, result, { store });
      const step = result.step;
      const stepRow = await tx.select({ id: approvalSteps.id }).from(approvalSteps).where(and(eq(approvalSteps.planId, result.planId!), eq(approvalSteps.seq, step.seq)));
      // Delegates: the audit actor is the person who clicked, on behalf of the absent approver.
      await emit(tx, { ...who, onBehalfOf: step.onBehalfOf }, action.requestId, {
        action: "approval.decided",
        entityType: "approval_step",
        entityId: String(stepRow[0]?.id ?? `${result.planId}#${step.seq}`),
        invoiceId,
        before: { decision: "pending", seq: step.seq, role: step.role, assignedTo: step.assignedTo },
        after: { decision: step.decision, seq: step.seq, role: step.role, actedAs: step.actedAs, acknowledgedFlags: step.acknowledgedFlags },
        reason: step.comment,
        metadata: { invoiceVersion: inv.version, planId: result.planId, isLastStep: result.isLastStep },
      });
      const fired = await fire(action, invoiceId, result.event, { isLastStep: result.isLastStep, reason: step.decision === "rejected" ? (step.comment ?? undefined) : undefined });
      return { step, status: fired.to } as const;
    },
    { db },
  );
  if ("denied" in outcome && outcome.denied) {
    const d = outcome.denied;
    if (d.status === 403) await recordDenied(actor, { attempted: "approval.decide", reason: d.reason, invoiceId }, { db });
    throw new ApprovalFlowError(d.reason, d.status, d.code);
  }
  return outcome;
}
