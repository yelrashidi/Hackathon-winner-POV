import { ApprovalPlan, type ApprovalStep } from "@/contracts/approvals";
import type { DecisionResult } from "./decide";

/**
 * Feature 6 — where approval plans live.
 *
 *   saveApprovalPlan(plan)                       a freshly routed plan; appended, never overwritten
 *   getApprovalPlans(invoiceId)                  every plan the invoice ever had, oldest first
 *   getCurrentApprovalPlan(invoiceId, { invoiceVersion })   the latest plan for that version
 *   saveDecision(invoiceId, invoiceVersion, result)          persists one applyDecision() result
 *   importApprovalPlan(plan)                     seed / tests only: a plan that already has decisions
 *
 * All async: the Postgres version will be, so the signatures do not change when it swaps in.
 * Every function takes an optional `{ store }`: pass a store bound to the request's transaction
 * (load plan + invoice, decide, write and fire() in ONE transaction). Without it, the default
 * store is used.
 *
 * Route handler for approve / reject:
 *   const plan = await getCurrentApprovalPlan(invoice.id, { invoiceVersion: invoice.version, store });
 *   if (!plan) → 409
 *   const check = checkDecision(plan, invoiceRef, session.userId, body, ctx);   if (!check.ok) → check.status
 *   const result = applyDecision(plan, check, new Date());
 *   await saveDecision(invoice.id, invoice.version, result, { store });          // ApprovalStoreError → err.status
 *   await fire(invoice.id, result.event, actor, { isLastStep: result.isLastStep });
 *
 * Guarantees, whatever store is behind it:
 *   - a saved plan cannot carry decisions: the only way to record one is saveDecision()
 *   - a step is decided once (conditional write): the second of two simultaneous clicks gets CONFLICT
 *   - only the latest plan, for the invoice's current version, takes decisions; old plans are frozen
 *   - one plan in progress per version: no re-planning to shop for a different approver
 *   - returned plans are copies: changing one does not change what is stored
 */

// --- rows: the shape of the tables -------------------------------------------------------------

/**
 * One `approval_steps` row (docs/architecture/data-model.md): the step plus which plan and invoice
 * version it belongs to. Proposed additions to the documented table: plan_id, role, also_covers,
 * routed_to, reasons / resolution / acted_as (jsonb), acknowledged_flags.
 */
export interface ApprovalStepRow extends ApprovalStep {
  planId: string;
  invoiceId: string;
  invoiceVersion: number;
}

/**
 * One row of a proposed `approval_plans` table: plan-level fields (basis, exclusions, attention,
 * notes as jsonb). `attempt` counts submissions of this invoice: 1, 2, 3 … across all versions.
 */
export interface ApprovalPlanRow extends Omit<ApprovalPlan, "steps"> {
  planId: string;
  attempt: number;
}

/** What a database must provide. Postgres: four short queries, see each method. */
export interface ApprovalStore {
  /** INSERT INTO approval_plans …; INSERT INTO approval_steps … (same transaction). */
  insertPlan(plan: ApprovalPlanRow, steps: readonly ApprovalStepRow[]): Promise<void>;
  /** SELECT * FROM approval_plans WHERE invoice_id = $1 ORDER BY attempt */
  listPlans(invoiceId: string): Promise<ApprovalPlanRow[]>;
  /** SELECT * FROM approval_steps WHERE invoice_id = $1 ORDER BY plan_id, seq */
  listSteps(invoiceId: string): Promise<ApprovalStepRow[]>;
  /**
   * UPDATE approval_steps SET … WHERE plan_id = $1 AND seq = $2 AND decision = 'pending'
   * Returns true if a row changed, false if the step was no longer pending.
   */
  updatePendingStep(planId: string, seq: number, decided: ApprovalStepRow): Promise<boolean>;
}

// TEMP: db — in-memory stand-in for approval_plans / approval_steps until Postgres lands.
export class InMemoryApprovalStore implements ApprovalStore {
  private readonly plans = new Map<string, ApprovalPlanRow[]>(); // TEMP: db — keyed by invoiceId
  private readonly steps = new Map<string, ApprovalStepRow[]>(); // TEMP: db — keyed by invoiceId

  // TEMP: db
  async insertPlan(plan: ApprovalPlanRow, steps: readonly ApprovalStepRow[]): Promise<void> {
    this.plans.set(plan.invoiceId, [...(this.plans.get(plan.invoiceId) ?? []), structuredClone(plan)]);
    this.steps.set(plan.invoiceId, [...(this.steps.get(plan.invoiceId) ?? []), ...structuredClone([...steps])]);
  }

  // TEMP: db
  async listPlans(invoiceId: string): Promise<ApprovalPlanRow[]> {
    return structuredClone([...(this.plans.get(invoiceId) ?? [])].sort((a, b) => a.attempt - b.attempt));
  }

  // TEMP: db
  async listSteps(invoiceId: string): Promise<ApprovalStepRow[]> {
    return structuredClone([...(this.steps.get(invoiceId) ?? [])].sort((a, b) => a.planId.localeCompare(b.planId) || a.seq - b.seq));
  }

  // TEMP: db — the check and the write happen with no await between them, so this is atomic.
  async updatePendingStep(planId: string, seq: number, decided: ApprovalStepRow): Promise<boolean> {
    const rows = this.steps.get(decided.invoiceId) ?? [];
    const index = rows.findIndex((r) => r.planId === planId && r.seq === seq);
    const row = rows[index];
    if (!row || row.decision !== "pending") return false;
    rows[index] = structuredClone(decided);
    return true;
  }
}

let defaultStore: ApprovalStore = new InMemoryApprovalStore(); // TEMP: db

/** Swap the app-wide store (the Postgres one at boot, or a fresh one in a test). */
export function setDefaultApprovalStore(store: ApprovalStore): void {
  defaultStore = store;
}

export interface StoreOption {
  store?: ApprovalStore;
}

/** NOT_FOUND → 404, CONFLICT → 409, INVALID → 400. The message is safe to show. */
export class ApprovalStoreError extends Error {
  readonly code: "NOT_FOUND" | "CONFLICT" | "INVALID";
  constructor(code: "NOT_FOUND" | "CONFLICT" | "INVALID", message: string) {
    super(message);
    this.name = "ApprovalStoreError";
    this.code = code;
  }
  get status(): 404 | 409 | 400 {
    return this.code === "NOT_FOUND" ? 404 : this.code === "CONFLICT" ? 409 : 400;
  }
}

// --- rows <-> plans -----------------------------------------------------------------------------

function toRows(plan: ApprovalPlan, planId: string, attempt: number): { planRow: ApprovalPlanRow; stepRows: ApprovalStepRow[] } {
  const { steps, planId: _unsaved, ...rest } = plan;
  return {
    planRow: { ...rest, planId, attempt },
    stepRows: steps.map((s) => ({ ...s, planId, invoiceId: plan.invoiceId, invoiceVersion: plan.invoiceVersion })),
  };
}

/** Parsing strips the row-only columns and refuses a corrupt row instead of returning it. */
function fromRows(planRow: ApprovalPlanRow, stepRows: readonly ApprovalStepRow[]): ApprovalPlan {
  const steps = stepRows.filter((s) => s.planId === planRow.planId).sort((a, b) => a.seq - b.seq);
  const parsed = ApprovalPlan.safeParse({ ...planRow, steps });
  if (!parsed.success) throw new ApprovalStoreError("CONFLICT", `Stored approval plan ${planRow.planId} is corrupt; resubmit the invoice.`);
  return parsed.data;
}

const isInProgressOrApproved = (row: ApprovalPlanRow, steps: readonly ApprovalStepRow[]) =>
  row.outcome === "route" && !steps.some((s) => s.planId === row.planId && s.decision === "rejected");

// --- the API ------------------------------------------------------------------------------------

/** Store a freshly routed plan (planApprovals output). Appends; old plans are kept. */
export async function saveApprovalPlan(plan: ApprovalPlan, opts: StoreOption = {}): Promise<void> {
  const parsed = ApprovalPlan.safeParse(plan);
  if (!parsed.success || !plan.invoiceId) throw new ApprovalStoreError("INVALID", "Not a valid approval plan.");
  const decided = plan.steps.find((s) => s.decision !== "pending" || s.actedBy !== null || s.decidedAt !== null);
  if (decided) {
    throw new ApprovalStoreError("INVALID", `A new plan cannot carry decisions (step ${decided.seq} is ${decided.decision}); decisions are recorded with saveDecision().`);
  }
  await append(parsed.data, opts, true);
}

/**
 * Seed and tests only — never from a request handler: stores a plan that already has decisions
 * (historical approvals.csv, the `approved` fixtures). Same append-only rules otherwise.
 */
export async function importApprovalPlan(plan: ApprovalPlan, opts: StoreOption = {}): Promise<void> {
  const parsed = ApprovalPlan.safeParse(plan);
  if (!parsed.success || !plan.invoiceId) throw new ApprovalStoreError("INVALID", "Not a valid approval plan.");
  await append(parsed.data, opts, false);
}

async function append(plan: ApprovalPlan, opts: StoreOption, guardInProgress: boolean): Promise<void> {
  if (plan.planId) throw new ApprovalStoreError("INVALID", `This plan is already stored as ${plan.planId}; plans are never saved twice.`);
  const store = opts.store ?? defaultStore;
  const existing = await store.listPlans(plan.invoiceId);
  const latest = existing[existing.length - 1];
  if (latest && plan.invoiceVersion < latest.invoiceVersion) {
    throw new ApprovalStoreError("CONFLICT", `Invoice ${plan.invoiceId} already has a plan for version ${latest.invoiceVersion}; a plan for version ${plan.invoiceVersion} is out of date.`);
  }
  if (guardInProgress && latest && plan.invoiceVersion === latest.invoiceVersion && isInProgressOrApproved(latest, await store.listSteps(plan.invoiceId))) {
    throw new ApprovalStoreError(
      "CONFLICT",
      `Version ${plan.invoiceVersion} of invoice ${plan.invoiceId} is already in approval or approved; a new plan needs a rejection or an edit (new version) first.`,
    );
  }
  const attempt = existing.length + 1;
  const { planRow, stepRows } = toRows(plan, `${plan.invoiceId}#${attempt}`, attempt);
  await store.insertPlan(planRow, stepRows);
}

/** Every plan the invoice ever had, all versions, oldest first. Feed straight into approversOf(...plans). */
export async function getApprovalPlans(invoiceId: string, opts: StoreOption = {}): Promise<ApprovalPlan[]> {
  const store = opts.store ?? defaultStore;
  const [rows, steps] = await Promise.all([store.listPlans(invoiceId), store.listSteps(invoiceId)]);
  return rows.map((r) => fromRows(r, steps));
}

/**
 * The plan that counts now. With `invoiceVersion` (pass invoices.version): the latest plan for
 * that version, or null if the invoice was edited and not resubmitted yet. Without it: the latest
 * plan of any version, so check `plan.invoiceVersion` against the invoice before relying on it.
 */
export async function getCurrentApprovalPlan(invoiceId: string, opts: StoreOption & { invoiceVersion?: number } = {}): Promise<ApprovalPlan | null> {
  const plans = await getApprovalPlans(invoiceId, opts);
  const candidates = opts.invoiceVersion === undefined ? plans : plans.filter((p) => p.invoiceVersion === opts.invoiceVersion);
  const latest = candidates[candidates.length - 1];
  // A plan for this version that was superseded by a newer version's plan is not current.
  if (latest && opts.invoiceVersion !== undefined && plans[plans.length - 1] !== latest) return null;
  return latest ?? null;
}

/** Persist one applyDecision() result. Throws ApprovalStoreError (map err.status to the response). */
export async function saveDecision(invoiceId: string, invoiceVersion: number, result: DecisionResult, opts: StoreOption = {}): Promise<void> {
  const store = opts.store ?? defaultStore;
  const step = result.step;
  if (step.decision === "pending" || !step.actedBy || !step.decidedAt) {
    throw new ApprovalStoreError("INVALID", "Only a decided step from applyDecision() can be saved.");
  }
  if (!result.planId) throw new ApprovalStoreError("INVALID", "Decide on a plan loaded from the store (getCurrentApprovalPlan), not on an unsaved plan.");
  const plans = await store.listPlans(invoiceId);
  const latest = plans[plans.length - 1];
  if (!latest) throw new ApprovalStoreError("NOT_FOUND", `Invoice ${invoiceId} has no approval plan.`);
  if (latest.invoiceVersion !== invoiceVersion) {
    throw new ApprovalStoreError("CONFLICT", `The current approval plan is for version ${latest.invoiceVersion}, but the invoice is at version ${invoiceVersion}; resubmit it.`);
  }
  if (result.planId !== latest.planId) {
    throw new ApprovalStoreError("CONFLICT", "This decision was made on an older plan, which has since been replaced; reload and try again.");
  }
  const steps = (await store.listSteps(invoiceId)).filter((s) => s.planId === latest.planId);
  const stored = steps.find((s) => s.seq === step.seq);
  if (!stored) throw new ApprovalStoreError("NOT_FOUND", `Step ${step.seq} does not exist on the current plan.`);
  if (stored.role !== step.role || stored.routedTo !== step.routedTo || stored.assignedTo !== step.assignedTo) {
    throw new ApprovalStoreError("CONFLICT", `This decision was made on a different plan than the current one; reload and try again.`);
  }
  if (steps.some((s) => s.decision === "rejected") || steps.some((s) => s.seq < step.seq && s.decision !== "approved")) {
    throw new ApprovalStoreError("CONFLICT", `Step ${step.seq} is not the step waiting for a decision; reload and try again.`);
  }
  const changed = await store.updatePendingStep(latest.planId, step.seq, { ...step, planId: latest.planId, invoiceId, invoiceVersion });
  if (!changed) throw new ApprovalStoreError("CONFLICT", `Step ${step.seq} was already decided by someone else; reload and try again.`);
}
