import type { ApprovalPlan, ApprovalStep } from "@/contracts/approvals";
import { APPROVING_ROLES, displayName, type ApprovalContext } from "./directory";

/**
 * Feature 6 — the approve / reject gate. Pure, so authorize() and the route handler share it:
 *
 *   const check = checkDecision(plan, invoice, session.userId, { action, comment }, ctx);
 *   if (!check.ok) return Response.json({ code: check.code, reason: check.reason }, { status: check.status });
 *   const result = applyDecision(plan, check, session.userId, { action, comment }, new Date());
 *   // in ONE transaction: write result.step to approval_steps, then
 *   // fire(invoiceId, result.event, actor) with guard isLastStep, which writes the audit event
 *   // (actor = actedBy, on_behalf_of = result.step.onBehalfOf).
 *
 * The actor id must come from the server session, never from the request body.
 */

export type DecisionAction = "approve" | "reject";

export interface DecisionRequest {
  action: DecisionAction;
  comment?: string | null;
}

export interface InvoiceRef {
  invoiceVersion: number;
  requesterId: string;
  submittedBy: string | null;
}

export type DecisionDeniedCode =
  | "STALE_PLAN"
  | "NOT_ROUTED"
  | "ALREADY_DECIDED"
  | "UNKNOWN_USER"
  | "USER_INACTIVE"
  | "SELF_APPROVAL"
  | "ROLE_CANNOT_APPROVE"
  | "ALREADY_SIGNED"
  | "NOT_ASSIGNED"
  | "COMMENT_REQUIRED";

export type DecisionCheck =
  | { ok: true; step: ApprovalStep; onBehalfOf: string | null }
  | { ok: false; status: 400 | 403 | 409; code: DecisionDeniedCode; reason: string };

type PlanState = Pick<ApprovalPlan, "invoiceVersion" | "outcome" | "steps">;

export function currentStep(plan: Pick<ApprovalPlan, "steps">): ApprovalStep | undefined {
  if (plan.steps.some((s) => s.decision === "rejected")) return undefined;
  return [...plan.steps].sort((a, b) => a.seq - b.seq).find((s) => s.decision === "pending");
}

export function checkDecision(
  plan: PlanState,
  invoice: InvoiceRef,
  actorId: string,
  request: DecisionRequest,
  ctx: Pick<ApprovalContext, "users">,
): DecisionCheck {
  const deny = (status: 400 | 403 | 409, code: DecisionDeniedCode, reason: string): DecisionCheck => ({ ok: false, status, code, reason });

  if (plan.invoiceVersion !== invoice.invoiceVersion) {
    return deny(409, "STALE_PLAN", "The invoice was edited after it was routed; its approvals are void and it must be resubmitted.");
  }
  if (plan.outcome !== "route") {
    return deny(409, "NOT_ROUTED", "This invoice is not waiting for approval.");
  }
  const step = currentStep(plan);
  if (!step) {
    return deny(409, "ALREADY_DECIDED", "Every approval step on this invoice has already been decided.");
  }

  const actor = ctx.users.get(actorId);
  if (!actor) return deny(403, "UNKNOWN_USER", "Unknown user.");
  if (actor.status !== "active") {
    return deny(403, "USER_INACTIVE", `Your account is ${actor.status.replace("_", " ")}, so you cannot approve.`);
  }
  if (actorId === invoice.requesterId || actorId === invoice.submittedBy) {
    return deny(403, "SELF_APPROVAL", "You requested or submitted this invoice, so you cannot approve it. It is routed to your manager.");
  }
  if (!APPROVING_ROLES.has(actor.role)) {
    return deny(403, "ROLE_CANNOT_APPROVE", `Your role (${actor.role}) cannot approve invoices.`);
  }
  const signed = plan.steps.find((s) => s.decision === "approved" && s.actedBy === actorId);
  if (signed) {
    return deny(403, "ALREADY_SIGNED", `You already approved step ${signed.seq}; another person must approve step ${step.seq}.`);
  }

  let onBehalfOf: string | null = null;
  if (actorId === step.assignedTo) {
    onBehalfOf = step.onBehalfOf;
  } else {
    // Late delegation: the assignee went on leave after the invoice was routed.
    const assignee = ctx.users.get(step.assignedTo);
    if (assignee?.status === "on_leave" && assignee.delegateId === actorId) {
      onBehalfOf = assignee.id;
    } else {
      return deny(403, "NOT_ASSIGNED", `Step ${step.seq} (${step.role}) is assigned to ${displayName(ctx, step.assignedTo)}.`);
    }
  }

  if (request.action === "reject" && !request.comment?.trim()) {
    return deny(400, "COMMENT_REQUIRED", "Say why you are rejecting; the clerk sees this reason.");
  }
  return { ok: true, step, onBehalfOf };
}

export interface DecisionResult {
  steps: ApprovalStep[];
  step: ApprovalStep;
  /** Event for core/fire: stepApproved → PendingApproval or Approved, stepRejected → InReview. */
  event: "stepApproved" | "stepRejected";
  isLastStep: boolean;
}

export function applyDecision(
  plan: Pick<ApprovalPlan, "steps">,
  check: Extract<DecisionCheck, { ok: true }>,
  actorId: string,
  request: DecisionRequest,
  now: Date,
): DecisionResult {
  const decided: ApprovalStep = {
    ...check.step,
    decision: request.action === "approve" ? "approved" : "rejected",
    actedBy: actorId,
    onBehalfOf: check.onBehalfOf,
    comment: request.comment?.trim() || null,
    decidedAt: now.toISOString(),
  };
  const steps = plan.steps.map((s) => (s.seq === decided.seq ? decided : s));
  const isLastStep = request.action === "approve" && steps.every((s) => s.decision === "approved");
  return { steps, step: decided, event: request.action === "approve" ? "stepApproved" : "stepRejected", isLastStep };
}

/**
 * Everyone who approved, including whoever a delegate signed for. Payments (feature 7) calls this
 * for P11: none of these people may release the payment (docs/architecture/roles-and-permissions.md rule 2).
 */
export function approversOf(plan: Pick<ApprovalPlan, "steps">): Set<string> {
  const ids = new Set<string>();
  for (const s of plan.steps) {
    if (s.decision !== "approved") continue;
    if (s.actedBy) ids.add(s.actedBy);
    if (s.onBehalfOf) ids.add(s.onBehalfOf);
  }
  return ids;
}

/** For the approver's queue: is this plan waiting on `userId` right now (directly or as delegate)? */
export function isAwaiting(plan: PlanState, userId: string, ctx: Pick<ApprovalContext, "users">): boolean {
  if (plan.outcome !== "route") return false;
  const step = currentStep(plan);
  if (!step) return false;
  if (step.assignedTo === userId) return true;
  const assignee = ctx.users.get(step.assignedTo);
  return assignee?.status === "on_leave" && assignee.delegateId === userId;
}
