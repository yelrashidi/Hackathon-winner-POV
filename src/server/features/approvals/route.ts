import {
  ApprovalInput,
  SPLIT_FLAG_CODE,
  type ApprovalPlan,
  type ApprovalPolicy,
  type ApprovalStep,
  type ApproverRole,
  type AttentionFlag,
  type ExcludedApprover,
  type ParsedApprovalInput,
  type PolicyReason,
} from "@/contracts/approvals";
import type { Flag } from "@/contracts/flag";
import {
  REQUESTING_ROLES,
  ROUTABLE_VENDOR_STATUSES,
  clip,
  displayName,
  formatCad,
  type ApprovalContext,
  type DirectoryVendor,
} from "./directory";
import { resolveRole } from "./resolve";

/**
 * Feature 6 — routing. Pure: (invoice after analysis, reference data) → ApprovalPlan.
 * The caller persists plan.steps as approval_steps for input.invoiceVersion, then fires
 * `submit` (outcome "route") or `hold` (outcome "hold"). "blocked" stays in InReview.
 *
 *   0. amounts     CAD total must match currency × rate (an unconverted USD total under-routes)
 *   1. amount      |total CAD| (credit notes are negative), raised by a split-invoice flag
 *   2. exclusions  requester, submitter, PO requester (self); flag overriders, vendor-master
 *                  maintainers, beneficiaries (conflict): never sign
 *   3. sanity      requester, department and vendor exist and are usable; budget
 *   4. chain       highest-priority active amount `chain` policy (P01–P04)
 *   5. extras      add_step / hold policies (P05, P06, P12, P13)
 *   6. people      resolve.ts: escalation, delegation, one person one step, limits
 *   7. authority   someone on the chain must have a limit ≥ the routing amount
 *   8. context     exceptions to acknowledge, earlier rejections of this invoice
 *
 * `history` = this invoice's earlier plans (any version), so approvers see why it bounced before.
 */

export type PlanHistory = Pick<ApprovalPlan, "invoiceVersion" | "steps">;

const ROLE_ORDER: Record<ApproverRole, number> = { dept_manager: 0, finance_manager: 1, controller_admin: 2, cfo: 3 };
const DAY_MS = 86_400_000;
/** Rounding allowance when re-checking total × FX rate against the stored CAD total. */
const FX_TOLERANCE_CENTS = 1;

interface StepRequest {
  role: ApproverRole;
  policy: ApprovalPolicy | null;
  message: string;
}

const isCents = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

export function planApprovals(rawInput: ApprovalInput, ctx: ApprovalContext, history: readonly PlanHistory[] = []): ApprovalPlan {
  const input = ApprovalInput.parse(rawInput);
  const policies = ctx.policies.filter((p) => p.active && p.ruleType !== "payment_release");
  /** open + overridden: the condition is still true. Resolved flags are history. */
  const live = input.flags.filter((f) => f.status !== "resolved");

  const blockers: PolicyReason[] = [];
  const holdReasons: PolicyReason[] = [];
  const notes: PolicyReason[] = [];
  const hold = (message: string, policyId: string | null = null) => holdReasons.push({ policyId, message });
  const note = (message: string, policyId: string | null = null) => notes.push({ policyId, message });

  for (const f of input.flags) {
    if (f.severity !== "block") continue;
    if (f.status === "open") blockers.push({ policyId: null, message: `${f.code}: ${f.message}` });
    if (f.status === "overridden" && !f.resolvedBy) {
      blockers.push({ policyId: null, message: `${f.code} was overridden without recording who did it, so the override cannot be honoured.` });
    }
  }

  // 0. Amounts -----------------------------------------------------------------------------------
  checkCurrency(input, hold);

  // 1. Routing amount ----------------------------------------------------------------------------
  let routingCadCents = Math.abs(input.totalCadCents);
  const ownCadCents = routingCadCents;
  if (input.totalCadCents < 0) note(`Credit note for ${formatCad(ownCadCents)} CAD: approving it applies the credit; no payment is released.`);
  if (input.totalCadCents === 0) note("The invoice total is $0.00; check it is not an extraction error.");

  let splitWithoutTotal = false;
  for (const f of live.filter((x) => x.code === SPLIT_FLAG_CODE)) {
    const combined = f.evidence["combinedCadCents"];
    if (isCents(combined) && combined >= 0) routingCadCents = Math.max(routingCadCents, combined);
    else splitWithoutTotal = true;
  }
  if (routingCadCents > ownCadCents) {
    note(`Routed at the combined ${formatCad(routingCadCents)} CAD of a suspected split, not this invoice's ${formatCad(ownCadCents)}.`);
  }

  // 2. Who may never sign -----------------------------------------------------------------------
  const excluded = new Map<string, string>();
  const exclusionKind = new Map<string, ExcludedApprover["kind"]>();
  const exclude = (id: string | null | undefined, why: string, kind: ExcludedApprover["kind"]) => {
    if (!id || excluded.has(id)) return;
    excluded.set(id, why);
    exclusionKind.set(id, kind);
  };
  exclude(input.requesterId, "requested this invoice", "self");
  exclude(input.submittedBy, "submitted this invoice", "self");
  exclude(input.poRequesterId, `requested purchase order ${input.poId ?? ""}`.trim(), "self");
  for (const c of input.conflicts) exclude(c.userId, clip(c.reason, 160), "conflict");
  for (const f of input.flags) {
    if (f.status !== "overridden") continue;
    exclude(f.resolvedBy, `overrode the ${f.code} flag on this invoice`, "conflict");
    note(`${f.code} was overridden by ${displayName(ctx, f.resolvedBy)}${f.resolutionNote ? `: "${clip(f.resolutionNote, 160)}"` : " with no reason given"}.`);
  }

  // 3. Requester, department, vendor ------------------------------------------------------------
  const requester = ctx.users.get(input.requesterId);
  if (!requester) {
    hold(`Requester ${clip(input.requesterId)} is not a known user.`);
  } else {
    if (requester.status !== "active" && requester.status !== "on_leave") {
      hold(`Requester ${displayName(ctx, requester.id)} is ${String(requester.status).replace(/_/g, " ")}${requester.statusSince ? ` since ${requester.statusSince}` : ""}; assign an active requester.`);
    }
    if (!REQUESTING_ROLES.has(requester.role)) hold(`Requester ${displayName(ctx, requester.id)} has role ${requester.role}, which cannot request purchases.`);
    if (requester.departmentId !== input.departmentId) {
      note(`Requester ${displayName(ctx, requester.id)} works in ${deptName(ctx, requester.departmentId)} but the invoice is charged to ${deptName(ctx, input.departmentId)}.`);
    }
  }
  if (!ctx.departments.has(input.departmentId)) hold(`Department ${clip(input.departmentId)} does not exist.`);
  const overBudget = budgetMessage(input, ctx);
  if (overBudget) note(overBudget);
  const otherDepts = [...new Set(input.lineDepartmentIds)].filter((d) => d !== input.departmentId);
  if (otherDepts.length > 0) {
    note(`Lines are also charged to ${otherDepts.map((d) => deptName(ctx, d)).join(", ")}; only ${deptName(ctx, input.departmentId)}'s manager approves.`);
  }

  const vendor = input.vendorId ? ctx.vendors.get(input.vendorId) : undefined;
  if (!vendor) hold(`Vendor "${clip(input.vendorNameRaw)}" is not in the vendor master; onboard it before routing.`);
  else if (!ROUTABLE_VENDOR_STATUSES.has(vendor.status)) hold(`Vendor ${vendor.legalName} (${vendor.id}) is ${vendor.status.replace(/_/g, " ")}.`);

  // 4. Amount chain -------------------------------------------------------------------------------
  const requests: StepRequest[] = [];
  const chain = pickChainPolicy(policies, routingCadCents);
  if (!chain || chain.steps.type !== "chain") {
    hold(`No active amount policy covers ${formatCad(routingCadCents)} CAD.`);
  } else {
    for (const role of chain.steps.roles) {
      requests.push({ role, policy: chain, message: `${formatCad(routingCadCents)} CAD: ${chain.description}` });
    }
  }

  // 5. Extra steps and holds ----------------------------------------------------------------------
  for (const policy of policies) {
    if (policy.steps.type !== "add_step" && policy.steps.type !== "hold") continue;
    const why = conditionMessage(policy, input, vendor, live, routingCadCents, ctx);
    if (!why) continue;
    if (policy.steps.type === "hold") hold(why, policy.id);
    else requests.push({ role: policy.steps.role, policy, message: why });
  }
  if (splitWithoutTotal) {
    requests.push({
      role: "finance_manager",
      policy: null,
      message: `${SPLIT_FLAG_CODE} has no combined total, so the right approval tier is unknown; the finance manager reviews it.`,
    });
  }

  // 6. People -------------------------------------------------------------------------------------
  const steps: ApprovalStep[] = [];
  const taken = new Set<string>();
  const limitOf = (id: string) => ctx.users.get(id)?.approvalLimitCents ?? 0;
  const groups = groupByRole(requests);
  groups.forEach(([role, group], index) => {
    const authoritySoFar = Math.max(0, ...steps.map((s) => limitOf(s.assignedTo)));
    const minLimitCents = index === groups.length - 1 && authoritySoFar < routingCadCents ? routingCadCents : 0;
    const r = resolveRole(role, input.departmentId, { excluded, taken, minLimitCents }, ctx);
    const reasons = group.map((g) => ({ policyId: g.policy?.id ?? null, message: g.message }));
    const lead = group.find((g) => g.policy) ?? group[0];

    if (r.assignee) {
      taken.add(r.assignee);
      if (r.onBehalfOf) taken.add(r.onBehalfOf);
      steps.push({
        seq: steps.length + 1,
        role,
        alsoCovers: [],
        policyId: lead.policy?.id ?? null,
        policyVersion: lead.policy?.version ?? null,
        reasons,
        routedTo: r.routedTo ?? r.assignee,
        assignedTo: r.assignee,
        onBehalfOf: r.onBehalfOf,
        resolution: r.trail,
        decision: "pending",
        actedBy: null,
        actedAs: null,
        acknowledgedFlags: [],
        comment: null,
        decidedAt: null,
      });
      return;
    }
    // Nobody new is left, but someone already on the chain could sign this role too: one
    // signature covers both rather than a dead end (e.g. Finance dept > $250k: CFO = controller step).
    const host = r.takenFallback ? steps.find((s) => s.assignedTo === r.takenFallback) : undefined;
    if (host) {
      host.alsoCovers.push(role);
      host.reasons.push(...reasons);
      host.resolution.push(...r.trail, {
        policyId: null,
        message: `${displayName(ctx, host.assignedTo)} also signs as ${role}: no other eligible approver is left, and one person never signs two steps.`,
      });
      return;
    }
    hold(`No eligible ${role} approver. ${r.trail.map((t) => t.message).join(" ")}`, lead.policy?.id ?? null);
  });

  // 7. Authority ------------------------------------------------------------------------------------
  if (steps.length > 0) {
    const highest = Math.max(...steps.map((s) => limitOf(s.assignedTo)));
    if (highest < routingCadCents) {
      hold(`No approver on the chain has a limit of ${formatCad(routingCadCents)} CAD (highest is ${formatCad(highest)}).`);
    }
  } else if (holdReasons.length === 0 && blockers.length === 0) {
    hold("Routing produced no approval steps.");
  }

  // Approvers who report to the requester can find it hard to say no.
  if (requester) {
    for (const s of steps) {
      if (reportsTo(ctx, s.assignedTo, requester.id)) {
        note(`${displayName(ctx, s.assignedTo)} (step ${s.seq}) reports to the requester ${displayName(ctx, requester.id)}.`);
      }
    }
  }

  // 8. Earlier rounds of this invoice: approvers should know it bounced, and why.
  for (const prior of history) {
    for (const s of prior.steps) {
      if (s.decision !== "rejected") continue;
      const same = prior.invoiceVersion === input.invoiceVersion;
      note(
        `Rejected earlier${same ? "" : ` (version ${prior.invoiceVersion})`} by ${displayName(ctx, s.actedBy)}` +
          `${s.decidedAt ? ` on ${s.decidedAt.slice(0, 10)}` : ""}: "${clip(s.comment ?? "no reason recorded", 160)}"` +
          `${same ? ". Resubmitted with no change since." : "."}`,
      );
    }
  }

  return {
    invoiceId: input.invoiceId,
    invoiceVersion: input.invoiceVersion,
    departmentId: input.departmentId,
    routedAt: ctx.asOf.toISOString(),
    outcome: blockers.length > 0 ? "blocked" : holdReasons.length > 0 ? "hold" : "route",
    routingCadCents,
    basis: {
      vendorId: input.vendorId,
      currency: input.currency,
      totalCents: input.totalCents,
      totalCadCents: input.totalCadCents,
      requesterId: input.requesterId,
      poId: input.poId?.trim() || null,
    },
    steps,
    excludedApprovers: [...excluded].map(([userId, reason]) => ({ userId, reason, kind: exclusionKind.get(userId) ?? "conflict" })),
    attention: attentionFlags(input.flags),
    holdReasons: [...blockers, ...holdReasons],
    notes,
  };
}

/**
 * Exceptions an approver must explicitly acknowledge: unresolved warnings, and anything that was
 * overridden. "I approved it, I never saw the price was over contract" stops being possible.
 */
function attentionFlags(flags: readonly Flag[]): AttentionFlag[] {
  const out = new Map<string, AttentionFlag>();
  for (const f of flags) {
    if (f.status === "resolved") continue;
    if (f.severity !== "warn" && f.status !== "overridden") continue;
    if (!out.has(f.code)) out.set(f.code, { code: f.code, severity: f.severity, status: f.status, message: f.message });
  }
  return [...out.values()];
}

/** "Takes Operations to $1,850,000.00 of its $1,800,000.00 annual budget (103%)", or null. */
function budgetMessage(input: ParsedApprovalInput, ctx: ApprovalContext): string | null {
  const dept = ctx.departments.get(input.departmentId);
  if (!dept?.annualBudgetCents || input.departmentSpendYtdCadCents === null || input.totalCadCents <= 0) return null;
  const after = input.departmentSpendYtdCadCents + input.totalCadCents;
  if (after <= dept.annualBudgetCents) return null;
  const pct = ((after / dept.annualBudgetCents) * 100).toFixed(1); // one decimal: never "100%" when over
  return `Takes ${dept.name} to ${formatCad(after)} of its ${formatCad(dept.annualBudgetCents)} annual budget (${pct}%).`;
}

// --- amounts -----------------------------------------------------------------------------------

function checkCurrency(input: ParsedApprovalInput, hold: (m: string) => void) {
  const { currency, totalCents, fxRateToCad, totalCadCents } = input;
  if (currency === "CAD") {
    if (fxRateToCad !== 1) hold(`A CAD invoice carries an FX rate of ${fxRateToCad}; expected 1.`);
    if (totalCadCents !== totalCents) hold(`CAD total ${formatCad(totalCadCents)} differs from the invoice total ${formatCad(totalCents)}.`);
    return;
  }
  if (fxRateToCad === 1) {
    hold(`${currency} invoice has an FX rate of exactly 1, so its total was probably never converted to CAD.`);
    return;
  }
  const expected = Math.round(totalCents * fxRateToCad);
  if (Math.abs(expected - totalCadCents) > FX_TOLERANCE_CENTS) {
    hold(`${currency} ${formatCad(totalCents).replace("$", "")} × ${fxRateToCad} = ${formatCad(expected)} CAD, but the invoice says ${formatCad(totalCadCents)} CAD.`);
  }
}

// --- policy evaluation -------------------------------------------------------------------------

function amountMatches(policy: ApprovalPolicy, cadCents: number): boolean {
  const c = policy.conditions;
  if (c.kind === "amount_up_to") return cadCents <= c.cadCents;
  if (c.kind === "amount_over") return cadCents > c.cadCents;
  return false;
}

/** Highest priority wins; on a tie the longer (stricter) chain wins. */
function pickChainPolicy(policies: readonly ApprovalPolicy[], cadCents: number): ApprovalPolicy | undefined {
  const chainLength = (p: ApprovalPolicy) => (p.steps.type === "chain" ? p.steps.roles.length : 0);
  return policies
    .filter((p) => p.steps.type === "chain" && amountMatches(p, cadCents))
    .sort((a, b) => b.priority - a.priority || chainLength(b) - chainLength(a))[0];
}

/** A sentence explaining why the policy applies, or null if it does not. */
function conditionMessage(
  policy: ApprovalPolicy,
  input: ParsedApprovalInput,
  vendor: DirectoryVendor | undefined,
  live: readonly Flag[],
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
      // Unknown or odd onboarding dates count as new: the safe side is an extra review.
      if (!vendor.onboardedAt) return `Vendor ${vendor.legalName} has no onboarding date on record.`;
      const onboarded = Date.parse(vendor.onboardedAt);
      if (Number.isNaN(onboarded)) return `Vendor ${vendor.legalName} has an unreadable onboarding date (${clip(vendor.onboardedAt, 30)}).`;
      const ageDays = Math.floor((ctx.asOf.getTime() - onboarded) / DAY_MS);
      if (ageDays < 0) return `Vendor ${vendor.legalName}'s onboarding date ${vendor.onboardedAt} is in the future.`;
      if (ageDays <= c.newVendorDays) return `Vendor ${vendor.legalName} was onboarded ${vendor.onboardedAt}, within the ${c.newVendorDays}-day new-vendor window.`;
      return null;
    }
    case "vendor_category":
      return vendor && vendor.category.trim().toLowerCase() === c.category.trim().toLowerCase() ? `Vendor category is ${vendor.category.trim()}.` : null;
    case "flag_raised": {
      const flag = live.find((f) => f.code === c.code);
      return flag ? `${flag.code}${flag.status === "overridden" ? " (overridden, still applies)" : ""}: ${flag.message}` : null;
    }
    case "po_required_missing":
      return vendor?.requiresPo && !input.poId?.trim() ? `${vendor.legalName} requires a purchase order and the invoice has none.` : null;
    case "department_over_budget":
      return budgetMessage(input, ctx);
    case "always":
      return policy.description;
    case "self_approval":
    case "approver_on_leave":
      return null; // resolution rules, applied in resolve.ts
  }
}

function groupByRole(requests: readonly StepRequest[]): [ApproverRole, StepRequest[]][] {
  const byRole = new Map<ApproverRole, StepRequest[]>();
  for (const r of requests) byRole.set(r.role, [...(byRole.get(r.role) ?? []), r]);
  return [...byRole.entries()].sort(([a], [b]) => ROLE_ORDER[a] - ROLE_ORDER[b]);
}

// --- org helpers -------------------------------------------------------------------------------

function deptName(ctx: ApprovalContext, id: string): string {
  const d = ctx.departments.get(id);
  return d ? `${d.name} (${d.id})` : clip(id, 20);
}

/** Is `bossId` anywhere above `userId` in the management chain? Cycle-safe. */
function reportsTo(ctx: ApprovalContext, userId: string, bossId: string): boolean {
  const seen = new Set<string>();
  let current = ctx.users.get(userId)?.managerId ?? null;
  while (current && !seen.has(current)) {
    if (current === bossId) return true;
    seen.add(current);
    current = ctx.users.get(current)?.managerId ?? null;
  }
  return false;
}
