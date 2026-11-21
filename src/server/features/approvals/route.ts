import {
  ApprovalInput,
  SPLIT_FLAG_CODE,
  type ApprovalPlan,
  type ApprovalPolicy,
  type ApprovalStep,
  type ApproverRole,
  type ParsedApprovalInput,
  type PolicyReason,
} from "@/contracts/approvals";
import type { Flag } from "@/contracts/flag";
import {
  APPROVING_ROLES,
  displayName,
  formatCad,
  type ApprovalContext,
  type DirectoryUser,
  type DirectoryVendor,
} from "./directory";

/**
 * Feature 6 — routing. Pure: (invoice after analysis, reference data) → ApprovalPlan.
 * The caller persists plan.steps as approval_steps for input.invoiceVersion, then fires
 * `submit` (outcome "route") or `hold` (outcome "hold") through core/fire.
 *
 * Order of work:
 *   1. routing amount   |total CAD| (credit notes are negative), bumped by a split-invoice flag
 *   2. amount chain     highest-priority active `chain` policy whose amount condition matches
 *   3. extra steps      add_step policies (new/pending vendor, Legal, PO over balance)
 *   4. holds            hold policies (PO required), vendor not payable, unknown requester
 *   5. people           role → person, then delegation (P08) and escalation (P07, one person per step)
 *   6. authority        someone on the chain must have a limit ≥ the routing amount
 */

const ROLE_ORDER: Record<ApproverRole, number> = {
  dept_manager: 0,
  finance_manager: 1,
  controller_admin: 2,
  cfo: 3,
};
const DAY_MS = 86_400_000;
const ROUTABLE_VENDOR_STATUSES = new Set(["active", "pending_review"]);

interface StepRequest {
  role: ApproverRole;
  policy: ApprovalPolicy;
  message: string;
}

export function planApprovals(rawInput: ApprovalInput, ctx: ApprovalContext): ApprovalPlan {
  const input = ApprovalInput.parse(rawInput);
  const policies = ctx.policies.filter((p) => p.active && p.ruleType !== "payment_release");
  const openFlags = input.flags.filter((f) => f.status === "open");

  const blockers: PolicyReason[] = openFlags
    .filter((f) => f.severity === "block")
    .map((f) => ({ policyId: null, message: `${f.code}: ${f.message}` }));
  const holdReasons: PolicyReason[] = [];
  const notes: PolicyReason[] = [];

  // 1. Routing amount -------------------------------------------------------------------------
  let routingCadCents = Math.abs(input.totalCadCents);
  if (input.totalCadCents < 0) {
    notes.push({
      policyId: null,
      message: `Credit note for ${formatCad(routingCadCents)} CAD: approving it applies the credit; no payment is released.`,
    });
  }
  const split = openFlags.find((f) => f.code === SPLIT_FLAG_CODE);
  const combined = split?.evidence["combinedCadCents"];
  if (typeof combined === "number" && Number.isInteger(combined) && combined > routingCadCents) {
    notes.push({
      policyId: null,
      message: `Routed at the combined ${formatCad(combined)} CAD of a suspected split, not this invoice's ${formatCad(routingCadCents)}.`,
    });
    routingCadCents = combined;
  }

  // Requester ----------------------------------------------------------------------------------
  const requester = ctx.users.get(input.requesterId);
  if (!requester) {
    holdReasons.push({ policyId: null, message: `Requester ${input.requesterId} is not a known user.` });
  } else if (requester.status === "terminated") {
    notes.push({
      policyId: null,
      message: `Requester ${displayName(ctx, requester.id)} was terminated${requester.statusSince ? ` on ${requester.statusSince}` : ""}; confirm the purchase is legitimate.`,
    });
  }

  // Vendor -------------------------------------------------------------------------------------
  const vendor = input.vendorId ? ctx.vendors.get(input.vendorId) : undefined;
  if (!vendor) {
    holdReasons.push({
      policyId: null,
      message: `Vendor "${input.vendorNameRaw}" is not in the vendor master; onboard it before routing.`,
    });
  } else if (!ROUTABLE_VENDOR_STATUSES.has(vendor.status)) {
    holdReasons.push({ policyId: null, message: `Vendor ${vendor.legalName} (${vendor.id}) is ${vendor.status.replace(/_/g, " ")}.` });
  }

  // 2. Amount chain ----------------------------------------------------------------------------
  const requests: StepRequest[] = [];
  const chain = pickChainPolicy(policies, routingCadCents);
  if (!chain || chain.steps.type !== "chain") {
    holdReasons.push({ policyId: null, message: `No active amount policy covers ${formatCad(routingCadCents)} CAD.` });
  } else {
    for (const role of chain.steps.roles) {
      requests.push({ role, policy: chain, message: `${formatCad(routingCadCents)} CAD: ${chain.description}` });
    }
  }

  // 3 + 4. Extra steps and holds ---------------------------------------------------------------
  for (const policy of policies) {
    if (policy.steps.type !== "add_step" && policy.steps.type !== "hold") continue;
    const why = conditionMessage(policy, input, vendor, openFlags, routingCadCents, ctx);
    if (!why) continue;
    if (policy.steps.type === "hold") holdReasons.push({ policyId: policy.id, message: why });
    else requests.push({ role: policy.steps.role, policy, message: why });
  }

  // 5. Roles → people --------------------------------------------------------------------------
  const selfPolicyId = ctx.policies.find((p) => p.steps.type === "escalate_to_manager")?.id ?? null;
  const delegatePolicyId = policies.find((p) => p.steps.type === "route_to_delegate")?.id ?? null;
  const excluded = new Set([input.requesterId, ...(input.submittedBy ? [input.submittedBy] : [])]);
  const taken = new Set<string>();
  const steps: ApprovalStep[] = [];

  for (const [role, group] of groupByRole(requests)) {
    const routedTo = baseUserFor(role, input.departmentId, ctx);
    if (!routedTo) {
      holdReasons.push({ policyId: group[0].policy.id, message: `Nobody holds the ${role} role for department ${input.departmentId}.` });
      continue;
    }
    const resolved = resolveAssignee(routedTo, excluded, taken, ctx, selfPolicyId, delegatePolicyId);
    if (!resolved.assignee) {
      holdReasons.push({
        policyId: group[0].policy.id,
        message: `No eligible ${role} approver: ${resolved.trail.map((t) => t.message).join(" ")}`,
      });
      continue;
    }
    taken.add(resolved.assignee);
    steps.push({
      seq: steps.length + 1,
      role,
      policyId: group[0].policy.id,
      policyVersion: group[0].policy.version,
      reasons: group.map((r) => ({ policyId: r.policy.id, message: r.message })),
      routedTo,
      assignedTo: resolved.assignee,
      onBehalfOf: resolved.onBehalfOf,
      resolution: resolved.trail,
      decision: "pending",
      actedBy: null,
      comment: null,
      decidedAt: null,
    });
  }

  // 6. Authority -------------------------------------------------------------------------------
  if (steps.length > 0) {
    const highest = Math.max(...steps.map((s) => ctx.users.get(s.assignedTo)?.approvalLimitCents ?? 0));
    if (highest < routingCadCents) {
      holdReasons.push({
        policyId: null,
        message: `No approver on the chain has a limit of ${formatCad(routingCadCents)} CAD (highest is ${formatCad(highest)}).`,
      });
    }
  }

  const outcome = blockers.length > 0 ? "blocked" : holdReasons.length > 0 ? "hold" : "route";
  return {
    invoiceId: input.invoiceId,
    invoiceVersion: input.invoiceVersion,
    outcome,
    routingCadCents,
    steps,
    holdReasons: [...blockers, ...holdReasons],
    notes,
  };
}

// --- policy evaluation ------------------------------------------------------------------------

function amountMatches(policy: ApprovalPolicy, cadCents: number): boolean {
  const c = policy.conditions;
  if (c.kind === "amount_up_to") return cadCents <= c.cadCents;
  if (c.kind === "amount_over") return cadCents > c.cadCents;
  return false;
}

function pickChainPolicy(policies: readonly ApprovalPolicy[], cadCents: number): ApprovalPolicy | undefined {
  return policies
    .filter((p) => p.steps.type === "chain" && amountMatches(p, cadCents))
    .sort((a, b) => b.priority - a.priority)[0];
}

/** A sentence explaining why the policy applies, or null if it does not. */
function conditionMessage(
  policy: ApprovalPolicy,
  input: ParsedApprovalInput,
  vendor: DirectoryVendor | undefined,
  openFlags: readonly Flag[],
  routingCadCents: number,
  ctx: ApprovalContext,
): string | null {
  const c = policy.conditions;
  switch (c.kind) {
    case "amount_up_to":
    case "amount_over":
      return amountMatches(policy, routingCadCents) ? `${formatCad(routingCadCents)} CAD: ${policy.description}` : null;
    case "vendor_new_or_pending": {
      if (!vendor) return null;
      if (vendor.status === "pending_review") return `Vendor ${vendor.legalName} is pending review.`;
      if (vendor.onboardedAt) {
        const ageDays = Math.floor((ctx.asOf.getTime() - Date.parse(vendor.onboardedAt)) / DAY_MS);
        if (ageDays >= 0 && ageDays <= c.newVendorDays) {
          return `Vendor ${vendor.legalName} was onboarded ${vendor.onboardedAt}, within the ${c.newVendorDays}-day new-vendor window.`;
        }
      }
      return null;
    }
    case "vendor_category":
      return vendor && vendor.category.toLowerCase() === c.category.toLowerCase()
        ? `Vendor category is ${vendor.category}.`
        : null;
    case "open_flag": {
      const flag = openFlags.find((f) => f.code === c.code);
      return flag ? `${flag.code}: ${flag.message}` : null;
    }
    case "po_required_missing":
      return vendor?.requiresPo && !input.poId ? `${vendor.legalName} requires a purchase order and the invoice has none.` : null;
    case "always":
      return policy.description;
    case "self_approval":
    case "approver_on_leave":
      return null; // resolution rules, applied in resolveAssignee
  }
}

function groupByRole(requests: readonly StepRequest[]): [ApproverRole, StepRequest[]][] {
  const byRole = new Map<ApproverRole, StepRequest[]>();
  for (const r of requests) byRole.set(r.role, [...(byRole.get(r.role) ?? []), r]);
  return [...byRole.entries()].sort(([a], [b]) => ROLE_ORDER[a] - ROLE_ORDER[b]);
}

// --- people ----------------------------------------------------------------------------------

/** Who the policy points at, before delegation and escalation. */
export function baseUserFor(role: ApproverRole, departmentId: string, ctx: ApprovalContext): string | null {
  switch (role) {
    case "dept_manager":
      return ctx.departments.get(departmentId)?.managerId ?? null;
    case "finance_manager":
      return pickUser(ctx, (u) => u.role === "finance_manager");
    case "controller_admin":
      // Two controller_admins exist: the Controller and the CFO. The CFO is the one with no manager.
      return pickUser(ctx, (u) => u.role === "controller_admin" && u.managerId !== null) ?? pickUser(ctx, (u) => u.role === "controller_admin");
    case "cfo":
      return pickUser(ctx, (u) => u.role === "controller_admin" && u.managerId === null);
  }
}

/** Not terminated; active before on-leave (so delegation can kick in); ties broken by id. */
function pickUser(ctx: ApprovalContext, pred: (u: DirectoryUser) => boolean): string | null {
  const hits = [...ctx.users.values()]
    .filter((u) => pred(u) && u.status !== "terminated")
    .sort((a, b) => Number(a.status !== "active") - Number(b.status !== "active") || a.id.localeCompare(b.id));
  return hits[0]?.id ?? null;
}

interface Resolution {
  assignee: string | null;
  onBehalfOf: string | null;
  trail: PolicyReason[];
}

/**
 * Walk from the policy's person to someone who can actually sign:
 *   on leave   → named delegate (P08), recorded as on behalf of; no delegate → manager
 *   terminated → manager
 *   requester / submitter → manager (P07)
 *   already holds another step on this invoice → manager (one person, one signature)
 *   role cannot approve (e.g. an employee set as delegate) → manager
 */
export function resolveAssignee(
  start: string,
  excluded: ReadonlySet<string>,
  taken: ReadonlySet<string>,
  ctx: ApprovalContext,
  selfPolicyId: string | null,
  delegatePolicyId: string | null,
): Resolution {
  const trail: PolicyReason[] = [];
  const seen = new Set<string>();
  let current: string | null = start;
  let onBehalfOf: string | null = null;

  const escalate = (u: DirectoryUser, why: string, policyId: string | null) => {
    trail.push({ policyId, message: `${displayName(ctx, u.id)} ${why}; escalated to their manager ${displayName(ctx, u.managerId)}.` });
    onBehalfOf = null;
    return u.managerId;
  };

  while (current && !seen.has(current)) {
    seen.add(current);
    const u = ctx.users.get(current);
    if (!u) {
      trail.push({ policyId: null, message: `${current} is not a known user.` });
      return { assignee: null, onBehalfOf: null, trail };
    }
    if (u.status === "on_leave") {
      const since = u.statusSince ? ` since ${u.statusSince}` : "";
      if (delegatePolicyId && u.delegateId) {
        trail.push({ policyId: delegatePolicyId, message: `${displayName(ctx, u.id)} is on leave${since}; routed to their delegate ${displayName(ctx, u.delegateId)}.` });
        onBehalfOf = u.id;
        current = u.delegateId;
      } else {
        current = escalate(u, `is on leave${since} with no delegate`, null);
      }
      continue;
    }
    if (u.status === "terminated") {
      current = escalate(u, "is terminated", null);
      continue;
    }
    if (excluded.has(u.id)) {
      current = escalate(u, "requested or submitted this invoice and cannot approve it", selfPolicyId);
      continue;
    }
    if (taken.has(u.id)) {
      current = escalate(u, "already holds another step on this invoice", null);
      continue;
    }
    if (!APPROVING_ROLES.has(u.role)) {
      current = escalate(u, `has role ${u.role}, which cannot approve`, null);
      continue;
    }
    return { assignee: u.id, onBehalfOf, trail };
  }
  trail.push({ policyId: null, message: "No eligible approver left up the management chain." });
  return { assignee: null, onBehalfOf: null, trail };
}
