import type { ApprovalPlan, ApprovalStep, ApproverRole, PolicyReason } from "@/contracts/approvals";
import { APPROVING_ROLES, displayName, formatCad, type ApprovalContext, type DirectoryUser } from "./directory";

/**
 * Who signs a step. Shared by routing (planApprovals) and the decision gate (checkDecision), so
 * the two can never disagree about who is allowed to act.
 *
 * For a role, try every holder of it as-is first (two finance managers: if one is the requester,
 * the other signs). Only then walk up from the policy's first choice:
 *
 *   excluded (requester, submitter, PO requester, flag overrider) → their manager      [checked FIRST:
 *   already signs another step on this invoice                    → their manager       a delegate never
 *   terminated / suspended / unknown status                       → their manager       signs for an
 *   on leave, P08 active, has a delegate                          → the delegate, once  excluded person]
 *   role cannot approve (employee, clerk, auditor)                → their manager
 *   approval limit below what this step must carry                → their manager
 *
 * Delegation is one hop: if the delegate cannot sign either, it escalates to the ABSENT person's
 * manager, not the delegate's. A delegate signs on behalf of the absent approver.
 */

export type ResolveContext = Pick<ApprovalContext, "users" | "departments" | "policies">;

export interface ResolveOptions {
  /** userId → why they may never sign this invoice. */
  excluded: ReadonlyMap<string, string>;
  /** People who already sign (or are signed for) another step of this invoice. */
  taken: ReadonlySet<string>;
  /** 0, or the routing amount when this step must carry the invoice's full authority. */
  minLimitCents: number;
}

export interface Resolution {
  assignee: string | null;
  onBehalfOf: string | null;
  routedTo: string | null;
  trail: PolicyReason[];
  /** First person who would have been eligible but already holds a step (for collapsing roles). */
  takenFallback: string | null;
}

type Block = { kind: "excluded" | "taken" | "inactive" | "leave" | "role" | "limit"; reason: string };

const policyIdFor = (ctx: ResolveContext, type: "escalate_to_manager" | "route_to_delegate", activeOnly: boolean) =>
  ctx.policies.find((p) => p.steps.type === type && (!activeOnly || p.active))?.id ?? null;

function blockFor(u: DirectoryUser, opts: ResolveOptions): Block | null {
  const excludedWhy = opts.excluded.get(u.id);
  if (excludedWhy) return { kind: "excluded", reason: excludedWhy };
  if (opts.taken.has(u.id)) return { kind: "taken", reason: "already signs another step on this invoice" };
  if (u.status === "on_leave") return { kind: "leave", reason: `is on leave${u.statusSince ? ` since ${u.statusSince}` : ""}` };
  if (u.status !== "active") return { kind: "inactive", reason: `is ${String(u.status).replace(/_/g, " ")}${u.statusSince ? ` since ${u.statusSince}` : ""}` };
  if (!APPROVING_ROLES.has(u.role)) return { kind: "role", reason: `has role ${u.role}, which cannot approve` };
  if (u.approvalLimitCents < opts.minLimitCents) {
    return { kind: "limit", reason: `has an approval limit of ${formatCad(u.approvalLimitCents)}, below the ${formatCad(opts.minLimitCents)} this invoice needs` };
  }
  return null;
}

function eligibleIfNotTaken(u: DirectoryUser, opts: ResolveOptions): boolean {
  return u.status === "active" && APPROVING_ROLES.has(u.role) && u.approvalLimitCents >= opts.minLimitCents && !opts.excluded.has(u.id);
}

/** Walk from `start` to someone who can sign. `escalate: false` stops instead of going to a manager. */
export function resolveFrom(start: string, opts: ResolveOptions, ctx: ResolveContext, escalate = true): Resolution {
  const selfPolicyId = policyIdFor(ctx, "escalate_to_manager", false); // P07 is always enforced
  const delegatePolicyId = policyIdFor(ctx, "route_to_delegate", true); // P08 can be switched off
  const trail: PolicyReason[] = [];
  const seen = new Set<string>();
  let current: string | null = start;
  let delegator: DirectoryUser | null = null; // set while we are trying an absent approver's delegate
  let takenFallback: string | null = null;

  while (current) {
    if (seen.has(current)) {
      trail.push({ policyId: null, message: `The management chain loops back to ${displayName(ctx, current)}.` });
      break;
    }
    seen.add(current);
    const u = ctx.users.get(current);
    const block: Block | null = u ? blockFor(u, opts) : { kind: "inactive", reason: "is not a known user" };
    if (u && !block) return { assignee: u.id, onBehalfOf: delegator?.id ?? null, routedTo: start, trail, takenFallback };
    if (u && block?.kind === "taken" && !takenFallback && eligibleIfNotTaken(u, opts)) takenFallback = u.id;

    // On leave → the named delegate (one hop only, never to themselves).
    if (u && block?.kind === "leave" && !delegator && delegatePolicyId && u.delegateId && u.delegateId !== u.id) {
      trail.push({ policyId: delegatePolicyId, message: `${displayName(ctx, u.id)} ${block.reason}; routed to their delegate ${displayName(ctx, u.delegateId)}.` });
      delegator = u;
      current = u.delegateId;
      continue;
    }

    // Escalate. If this was an absent approver's delegate, go to the absent approver's manager.
    const from: DirectoryUser | undefined = delegator ?? u;
    const who = u ? displayName(ctx, u.id) : current;
    const noDelegate = block?.kind === "leave" && !delegator ? (delegatePolicyId ? " with no delegate" : " (delegation is switched off)") : "";
    if (!escalate) {
      trail.push({ policyId: block?.kind === "excluded" ? selfPolicyId : null, message: `${who} ${block?.reason}${noDelegate}.` });
      break;
    }
    const target = from?.managerId ?? null;
    const whose = delegator ? `${displayName(ctx, delegator.id)}'s` : "their";
    trail.push({
      policyId: block?.kind === "excluded" ? selfPolicyId : null,
      message: target
        ? `${who} ${block?.reason}${noDelegate}; escalated to ${whose} manager ${displayName(ctx, target)}.`
        : `${who} ${block?.reason}${noDelegate}, and ${delegator ? displayName(ctx, delegator.id) : "they"} have no manager to escalate to.`,
    });
    delegator = null;
    current = target;
  }
  return { assignee: null, onBehalfOf: null, routedTo: start, trail, takenFallback };
}

/** Holders of a role, best first. Not terminated; active before on leave; ties by id. */
export function candidatesFor(role: ApproverRole, departmentId: string, ctx: ResolveContext): string[] {
  const holders = (pred: (u: DirectoryUser) => boolean) =>
    [...ctx.users.values()]
      .filter((u) => pred(u) && u.status !== "terminated")
      .sort((a, b) => Number(a.status !== "active") - Number(b.status !== "active") || a.id.localeCompare(b.id))
      .map((u) => u.id);
  switch (role) {
    case "dept_manager": {
      const manager = ctx.departments.get(departmentId)?.managerId;
      return manager ? [manager] : [];
    }
    case "finance_manager":
      return holders((u) => u.role === "finance_manager");
    case "controller_admin":
      // Two controller_admins exist: the Controller and the CFO. The CFO (no manager) is the fallback.
      return [
        ...holders((u) => u.role === "controller_admin" && u.managerId !== null),
        ...holders((u) => u.role === "controller_admin" && u.managerId === null),
      ];
    case "cfo":
      return holders((u) => u.role === "controller_admin" && u.managerId === null);
  }
}

export function resolveRole(role: ApproverRole, departmentId: string, opts: ResolveOptions, ctx: ResolveContext): Resolution {
  const candidates = candidatesFor(role, departmentId, ctx);
  if (candidates.length === 0) {
    const what = role === "dept_manager" ? `department ${departmentId} has no manager on record` : `nobody holds the ${role} role`;
    return { assignee: null, onBehalfOf: null, routedTo: null, trail: [{ policyId: null, message: `No ${role} approver: ${what}.` }], takenFallback: null };
  }
  // Pass 1: any holder of the role who can sign now (directly or via their delegate).
  let takenFallback: string | null = null;
  const skipped: PolicyReason[] = [];
  for (const c of candidates) {
    const r = resolveFrom(c, opts, ctx, false);
    if (r.assignee) return { ...r, routedTo: candidates[0], trail: [...skipped, ...r.trail] };
    takenFallback ??= r.takenFallback;
    skipped.push(...r.trail);
  }
  // Pass 2: nobody holding the role can sign; escalate from the first choice.
  const r = resolveFrom(candidates[0], opts, ctx, true);
  return { ...r, takenFallback: r.takenFallback ?? takenFallback };
}

/** Everyone who signed, or was signed for, an approved step. */
export function signersOf(steps: readonly ApprovalStep[], exceptSeq?: number): Set<string> {
  const ids = new Set<string>();
  for (const s of steps) {
    if (s.decision !== "approved" || s.seq === exceptSeq) continue;
    if (s.actedBy) ids.add(s.actedBy);
    if (s.onBehalfOf) ids.add(s.onBehalfOf);
  }
  return ids;
}

/** Highest approval limit among the people who actually signed (a delegate's OWN limit counts). */
export function signedAuthority(steps: readonly ApprovalStep[], ctx: Pick<ApprovalContext, "users">): number {
  let best = 0;
  for (const s of steps) {
    if (s.decision === "approved" && s.actedBy) best = Math.max(best, ctx.users.get(s.actedBy)?.approvalLimitCents ?? 0);
  }
  return best;
}

/**
 * Who may act on `step` right now, given today's leave, terminations and limits. Equal to
 * step.assignedTo unless something changed since routing: then it self-heals (delegate of an
 * assignee who went on leave, manager of one who was terminated, approver back from leave).
 */
export function effectiveAssignee(
  plan: Pick<ApprovalPlan, "steps" | "departmentId" | "excludedApprovers" | "routingCadCents">,
  step: ApprovalStep,
  ctx: ResolveContext,
  extraExcluded: ReadonlyMap<string, string> = new Map(),
): Resolution {
  const excluded = new Map(plan.excludedApprovers.map((e) => [e.userId, e.reason] as const));
  for (const [id, why] of extraExcluded) if (!excluded.has(id)) excluded.set(id, why);
  const othersApproved = plan.steps.every((s) => s.seq === step.seq || s.decision === "approved");
  const minLimitCents = othersApproved && signedAuthority(plan.steps, ctx) < plan.routingCadCents ? plan.routingCadCents : 0;
  return resolveRole(step.role, plan.departmentId, { excluded, taken: signersOf(plan.steps, step.seq), minLimitCents }, ctx);
}
