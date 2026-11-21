import { ApprovalPlan, type ApprovalStep } from "@/contracts/approvals";
import { APPROVING_ROLES, ROUTABLE_VENDOR_STATUSES, displayName, formatCad, type ApprovalContext } from "./directory";
import { effectiveAssignee, signedAuthority, signersOf, type Resolution } from "./resolve";

/**
 * Feature 6 — the approve / reject gate. Pure, so authorize() and the route handler share it:
 *
 *   const check = checkDecision(plan, invoice, session.userId, body, ctx);   // body is untrusted JSON
 *   if (!check.ok) return Response.json({ code: check.code, reason: check.reason }, { status: check.status });
 *   const result = applyDecision(plan, check, new Date());   // applies exactly what was checked
 *   // ONE transaction:
 *   //   UPDATE approval_steps SET … WHERE invoice_id = $1 AND invoice_version = $2 AND seq = $3 AND decision = 'pending'
 *   //   → 0 rows means someone else acted first: roll back and return 409 (two approvers, one click each).
 *   //   fire(invoiceId, result.event, actor, { isLastStep }) — writes the audit event with on_behalf_of.
 *
 * The actor id must come from the server session, never from the request body.
 */

export const PENDING_APPROVAL_STATUS = "PendingApproval";
const MAX_COMMENT_LENGTH = 2000;

export type DecisionAction = "approve" | "reject";

export interface DecisionRequest {
  action: DecisionAction;
  comment?: string | null;
  /** Codes from plan.attention the approver confirms they saw. Required for every code to approve. */
  acknowledgedFlags?: string[];
}

type ActedAs = NonNullable<ApprovalStep["actedAs"]>;

/** The invoice as it is NOW (loaded in the same transaction as the decision). */
export interface InvoiceRef {
  invoiceId: string;
  invoiceVersion: number;
  /** Invoice state-machine status, e.g. "PendingApproval". */
  status: string;
  requesterId: string;
  submittedBy: string | null;
  vendorId: string | null;
}

export type DecisionDeniedCode =
  | "INVALID_REQUEST"
  | "CORRUPT_PLAN"
  | "WRONG_INVOICE"
  | "STALE_PLAN"
  | "NOT_PENDING"
  | "NOT_ROUTED"
  | "ALREADY_DECIDED"
  | "UNKNOWN_USER"
  | "USER_INACTIVE"
  | "SELF_APPROVAL"
  | "CONFLICT_OF_INTEREST"
  | "ROLE_CANNOT_APPROVE"
  | "ALREADY_SIGNED"
  | "NO_ELIGIBLE_APPROVER"
  | "NOT_ASSIGNED"
  | "COMMENT_REQUIRED"
  | "FLAGS_NOT_ACKNOWLEDGED"
  | "VENDOR_NOT_PAYABLE"
  | "INSUFFICIENT_AUTHORITY";

export type DecisionCheck =
  | {
      ok: true;
      actorId: string;
      actedAs: ActedAs;
      step: ApprovalStep;
      onBehalfOf: string | null;
      request: DecisionRequest;
      acknowledgedFlags: string[];
    }
  | { ok: false; status: 400 | 403 | 409; code: DecisionDeniedCode; reason: string };

export type DecisionContext = Pick<ApprovalContext, "users" | "departments" | "vendors" | "policies">;

export function currentStep(plan: Pick<ApprovalPlan, "steps">): ApprovalStep | undefined {
  if (plan.steps.some((s) => s.decision === "rejected")) return undefined;
  return [...plan.steps].sort((a, b) => a.seq - b.seq).find((s) => s.decision === "pending");
}

/** The current invoice's own requester / submitter, on top of the plan's routing-time exclusions. */
function invoiceExclusions(invoice: Pick<InvoiceRef, "requesterId" | "submittedBy">): Map<string, string> {
  const m = new Map<string, string>([[invoice.requesterId, "requested this invoice"]]);
  if (invoice.submittedBy && !m.has(invoice.submittedBy)) m.set(invoice.submittedBy, "submitted this invoice");
  return m;
}

export function checkDecision(
  plan: ApprovalPlan,
  invoice: InvoiceRef,
  actorId: string,
  rawRequest: unknown,
  ctx: DecisionContext,
): DecisionCheck {
  const deny = (status: 400 | 403 | 409, code: DecisionDeniedCode, reason: string): DecisionCheck => ({ ok: false, status, code, reason });

  // The request body is whatever the client sent. Judges will send odd things.
  const body = (rawRequest ?? {}) as Record<string, unknown>;
  const action = body.action;
  const comment = body.comment;
  if (action !== "approve" && action !== "reject") return deny(400, "INVALID_REQUEST", 'action must be "approve" or "reject".');
  if (comment !== undefined && comment !== null && typeof comment !== "string") return deny(400, "INVALID_REQUEST", "comment must be text.");
  if (typeof comment === "string" && comment.length > MAX_COMMENT_LENGTH) {
    return deny(400, "INVALID_REQUEST", `comment is longer than ${MAX_COMMENT_LENGTH} characters.`);
  }
  const ack = body.acknowledgedFlags ?? [];
  if (!Array.isArray(ack) || ack.length > 100 || !ack.every((c) => typeof c === "string")) {
    return deny(400, "INVALID_REQUEST", "acknowledgedFlags must be a list of flag codes.");
  }
  const request: DecisionRequest = { action, comment: typeof comment === "string" ? comment : null, acknowledgedFlags: ack as string[] };

  // The plan comes from our own DB, but a corrupt row must not approve anything.
  const parsed = ApprovalPlan.safeParse(plan);
  if (!parsed.success || new Set(plan.steps.map((s) => s.seq)).size !== plan.steps.length) {
    return deny(409, "CORRUPT_PLAN", "The stored approval plan is invalid; resubmit the invoice to re-route it.");
  }
  if (plan.invoiceId !== invoice.invoiceId) return deny(409, "WRONG_INVOICE", "This approval plan belongs to a different invoice.");
  if (plan.invoiceVersion !== invoice.invoiceVersion) {
    return deny(409, "STALE_PLAN", "The invoice was edited after it was routed; its approvals are void and it must be resubmitted.");
  }
  if (invoice.status !== PENDING_APPROVAL_STATUS) return deny(409, "NOT_PENDING", `The invoice is ${invoice.status}, not waiting for approval.`);
  if (plan.outcome !== "route") return deny(409, "NOT_ROUTED", "This invoice was never routed for approval.");
  const step = currentStep(plan);
  if (!step) return deny(409, "ALREADY_DECIDED", "Every approval step on this invoice has already been decided.");

  // Who is asking --------------------------------------------------------------------------------
  const actor = ctx.users.get(actorId);
  if (!actor) return deny(403, "UNKNOWN_USER", "Unknown user.");
  if (actor.status !== "active") return deny(403, "USER_INACTIVE", `Your account is ${String(actor.status).replace(/_/g, " ")}, so you cannot approve.`);
  const extra = invoiceExclusions(invoice);
  const stored = plan.excludedApprovers.find((e) => e.userId === actorId);
  const excludedWhy = extra.get(actorId) ?? stored?.reason;
  if (excludedWhy) {
    const kind = extra.has(actorId) ? "self" : stored?.kind;
    return deny(
      403,
      kind === "self" ? "SELF_APPROVAL" : "CONFLICT_OF_INTEREST",
      `${displayName(ctx, actorId)} ${excludedWhy}, so they cannot approve it. It goes to someone independent of it.`,
    );
  }
  if (!APPROVING_ROLES.has(actor.role)) return deny(403, "ROLE_CANNOT_APPROVE", `Your role (${actor.role}) cannot approve invoices.`);
  if (signersOf(plan.steps).has(actorId)) {
    return deny(403, "ALREADY_SIGNED", `You already approved a step of this invoice (yourself or through your delegate); someone else must approve step ${step.seq}.`);
  }

  // Is it their turn — according to TODAY's leave, terminations and limits -----------------------
  const eff: Resolution = effectiveAssignee(plan, step, ctx, extra);
  if (!eff.assignee) {
    return deny(409, "NO_ELIGIBLE_APPROVER", `Nobody can sign step ${step.seq} (${step.role}) right now: ${eff.trail.map((t) => t.message).join(" ")} Resubmit to re-route.`);
  }
  if (eff.assignee !== actorId) return deny(403, "NOT_ASSIGNED", `Step ${step.seq} (${step.role}) is assigned to ${displayName(ctx, eff.assignee)}.`);

  const actedAs: ActedAs = { fullName: actor.fullName, role: actor.role, approvalLimitCents: actor.approvalLimitCents };
  if (request.action === "reject") {
    if (!request.comment?.trim()) return deny(400, "COMMENT_REQUIRED", "Say why you are rejecting; the clerk sees this reason.");
    return { ok: true, actorId, actedAs, step, onBehalfOf: eff.onBehalfOf, request, acknowledgedFlags: [] };
  }

  // Approving with exceptions on the invoice: each one must be explicitly acknowledged.
  const acknowledged = new Set(request.acknowledgedFlags);
  const missing = plan.attention.filter((a) => !acknowledged.has(a.code));
  if (missing.length > 0) {
    return deny(
      409,
      "FLAGS_NOT_ACKNOWLEDGED",
      `Acknowledge these exceptions to approve: ${missing.map((m) => `${m.code} (${m.message})`).join("; ")}.`,
    );
  }

  // Approving: the vendor must still be payable, and the finished chain must carry the amount.
  const vendor = invoice.vendorId ? ctx.vendors.get(invoice.vendorId) : undefined;
  if (!vendor || !ROUTABLE_VENDOR_STATUSES.has(vendor.status)) {
    const why = vendor ? `is ${vendor.status.replace(/_/g, " ")}` : "is not in the vendor master";
    return deny(409, "VENDOR_NOT_PAYABLE", `The vendor ${why}, so this invoice cannot be approved now. You can still reject it.`);
  }
  const isLast = plan.steps.every((s) => s.seq === step.seq || s.decision === "approved");
  if (isLast) {
    const authority = Math.max(signedAuthority(plan.steps, ctx), actor.approvalLimitCents);
    if (authority < plan.routingCadCents) {
      return deny(403, "INSUFFICIENT_AUTHORITY", `Nobody who signed has a limit of ${formatCad(plan.routingCadCents)} CAD (highest is ${formatCad(authority)}).`);
    }
  }
  return { ok: true, actorId, actedAs, step, onBehalfOf: eff.onBehalfOf, request, acknowledgedFlags: plan.attention.map((a) => a.code) };
}

export interface DecisionResult {
  /** The stored plan this decision was made on (undefined if the plan was never saved). */
  planId: string | undefined;
  steps: ApprovalStep[];
  step: ApprovalStep;
  /** Event for core/fire: stepApproved → PendingApproval or Approved, stepRejected → InReview. */
  event: "stepApproved" | "stepRejected";
  isLastStep: boolean;
}

/** Applies exactly the actor and request checkDecision allowed: no way to check one thing and apply another. */
export function applyDecision(plan: Pick<ApprovalPlan, "steps" | "planId">, check: Extract<DecisionCheck, { ok: true }>, now: Date): DecisionResult {
  const { actorId, request } = check;
  const target = plan.steps.find((s) => s.seq === check.step.seq);
  if (!target || target.decision !== "pending" || currentStep(plan)?.seq !== target.seq) {
    throw new Error(`applyDecision: step ${check.step.seq} is not the pending step of this plan; re-run checkDecision.`);
  }
  const decided: ApprovalStep = {
    ...target,
    decision: request.action === "approve" ? "approved" : "rejected",
    actedBy: actorId,
    actedAs: check.actedAs,
    acknowledgedFlags: check.acknowledgedFlags,
    onBehalfOf: check.onBehalfOf,
    comment: request.comment?.trim() || null,
    decidedAt: now.toISOString(),
  };
  const steps = plan.steps.map((s) => (s.seq === decided.seq ? decided : s));
  const isLastStep = request.action === "approve" && steps.every((s) => s.decision === "approved");
  return { planId: plan.planId, steps, step: decided, event: request.action === "approve" ? "stepApproved" : "stepRejected", isLastStep };
}

/**
 * Everyone who approved, including whoever a delegate signed for, across every plan the invoice
 * ever had (pass all of them: a round voided by an edit still counts). Payments (feature 7) uses
 * this for P11: none of these people may release the payment.
 */
export function approversOf(...plans: readonly Pick<ApprovalPlan, "steps">[]): Set<string> {
  const ids = new Set<string>();
  for (const plan of plans) for (const id of signersOf(plan.steps)) ids.add(id);
  return ids;
}

/** Who the current step is waiting on right now (for queues and the "with X" label). */
export function waitingOn(
  plan: ApprovalPlan,
  invoice: Pick<InvoiceRef, "requesterId" | "submittedBy">,
  ctx: DecisionContext,
): Resolution | null {
  if (plan.outcome !== "route") return null;
  const step = currentStep(plan);
  return step ? effectiveAssignee(plan, step, ctx, invoiceExclusions(invoice)) : null;
}

/** For the approver's queue: is this plan waiting on `userId` right now? */
export function isAwaiting(
  plan: ApprovalPlan,
  userId: string,
  invoice: Pick<InvoiceRef, "requesterId" | "submittedBy">,
  ctx: DecisionContext,
): boolean {
  return waitingOn(plan, invoice, ctx)?.assignee === userId;
}
