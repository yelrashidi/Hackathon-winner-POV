import { z } from "zod";
import { Flag, FlagSeverity, FlagStatus } from "./flag";

/**
 * Feature 6 — approvals. Input from the analysis pass (stages 1–5), the structured policy rows
 * an admin edits, and the plan approvals produces (persisted to `approval_steps`).
 * Rules for changing this file: docs/rules/contracts.md.
 */

/** Integer cents inside the range JavaScript can represent exactly. */
const Cents = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const NonNegativeCents = Cents.nonnegative();
const FlagCode = z.string().regex(/^[A-Z][A-Z0-9_]*$/);

// ---------------------------------------------------------------------------------------------
// Roles that can hold an approval step. `cfo` is not a user role in the data: it resolves to the
// controller_admin at the top of the org chart (no manager).
// ---------------------------------------------------------------------------------------------
export const ApproverRole = z.enum(["dept_manager", "finance_manager", "controller_admin", "cfo"]);
export type ApproverRole = z.infer<typeof ApproverRole>;

/** Release roles for step 7 (P09/P10). */
export const ReleaseRole = z.enum(["finance_manager", "controller_admin"]);
export type ReleaseRole = z.infer<typeof ReleaseRole>;

// ---------------------------------------------------------------------------------------------
// Policies: `approval_policies.conditions jsonb` = PolicyCondition, `steps jsonb` = PolicyEffect.
// Seeded from approval_policies.csv by policiesFromCsv(); edited by the Controller afterwards.
// ---------------------------------------------------------------------------------------------
export const PolicyCondition = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("amount_up_to"), cadCents: NonNegativeCents }),
  z.object({ kind: z.literal("amount_over"), cadCents: NonNegativeCents }),
  z.object({ kind: z.literal("vendor_new_or_pending"), newVendorDays: z.number().int().positive() }),
  z.object({ kind: z.literal("vendor_category"), category: z.string().trim().min(1) }),
  /** The invoice has this flag and it is not `resolved` (open or overridden both count). */
  z.object({ kind: z.literal("flag_raised"), code: FlagCode }),
  z.object({ kind: z.literal("po_required_missing") }),
  /** Year-to-date spend plus this invoice exceeds the department's annual budget. Not seeded; admin may add. */
  z.object({ kind: z.literal("department_over_budget") }),
  z.object({ kind: z.literal("self_approval") }),
  z.object({ kind: z.literal("approver_on_leave") }),
  z.object({ kind: z.literal("always") }),
]);
export type PolicyCondition = z.infer<typeof PolicyCondition>;

export const PolicyEffect = z.discriminatedUnion("type", [
  /** Amount tiers: the full sequential chain. The highest-priority matching chain wins. */
  z.object({ type: z.literal("chain"), roles: z.array(ApproverRole).min(1) }),
  /** Adds one step regardless of amount (P05, P06, P12). Merged if the chain already has the role. */
  z.object({ type: z.literal("add_step"), role: ApproverRole }),
  /** Park the invoice in OnHold (P13). */
  z.object({ type: z.literal("hold") }),
  /** P07. Always enforced (the brief requires it); the row exists so routing can cite it. */
  z.object({ type: z.literal("escalate_to_manager") }),
  /** P08. When inactive, an on-leave approver escalates to their manager instead. */
  z.object({ type: z.literal("route_to_delegate") }),
  /** Step 7 (P09/P10/P11). */
  z.object({ type: z.literal("release_by"), role: ReleaseRole }),
  z.object({ type: z.literal("release_not_approver") }),
]);
export type PolicyEffect = z.infer<typeof PolicyEffect>;

const AMOUNT_KINDS = new Set(["amount_up_to", "amount_over"]);
const RELEASE_EFFECTS = new Set(["release_by", "release_not_approver"]);

export const ApprovalPolicy = z
  .object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    active: z.boolean(),
    ruleType: z.enum(["approval", "payment_release", "match"]),
    /** Higher wins when several `chain` policies match; ties go to the longer chain. */
    priority: z.number().int(),
    conditions: PolicyCondition,
    steps: PolicyEffect,
    description: z.string(),
  })
  .superRefine((p, ctx) => {
    // Guard rails for the admin policy editor: a bad row should be rejected on save, not
    // silently change who approves.
    if (p.steps.type === "chain" && !AMOUNT_KINDS.has(p.conditions.kind)) {
      ctx.addIssue({ code: "custom", path: ["conditions"], message: "An approval chain must be keyed on an amount (amount_up_to / amount_over); use add_step for other conditions." });
    }
    if ((p.ruleType === "payment_release") !== RELEASE_EFFECTS.has(p.steps.type)) {
      ctx.addIssue({ code: "custom", path: ["steps"], message: "release_by / release_not_approver belong to payment_release policies, and only there." });
    }
  });
export type ApprovalPolicy = z.infer<typeof ApprovalPolicy>;

/**
 * Someone who may not sign any step of an invoice, and why. `reason` reads after a name:
 * "Dev Malhotra (U007) <reason>", e.g. "requested this invoice", "changed this vendor's bank
 * details on 2026-10-27", "is the person this purchase is for".
 *   self     — requester, submitter, PO requester (the brief's "approve what you requested")
 *   conflict — anything else that makes them not independent (overrode a flag, maintains the
 *              vendor in the vendor master, benefits from the purchase, related party)
 */
export const ExcludedApprover = z.object({
  userId: z.string().min(1),
  reason: z.string().min(1),
  kind: z.enum(["self", "conflict"]),
});
export type ExcludedApprover = z.infer<typeof ExcludedApprover>;

// ---------------------------------------------------------------------------------------------
// Input: what approvals needs from the invoice after the analysis pass.
// ---------------------------------------------------------------------------------------------
export const ApprovalInput = z.object({
  invoiceId: z.string().min(1),
  invoiceVersion: z.number().int().positive(),
  /** null until the invoice is matched to the vendor master. */
  vendorId: z.string().nullable(),
  vendorNameRaw: z.string(),
  departmentId: z.string().min(1),
  /** Set by the system from the submitting user or the PO, never from text on the invoice. */
  requesterId: z.string().min(1),
  /** The person who keyed / submitted it, if not the requester. Cannot approve either. */
  submittedBy: z.string().nullable().default(null),
  poId: z.string().nullable().default(null),
  /** Who requested the matched PO. They are the real requester, so they cannot approve either. */
  poRequesterId: z.string().nullable().default(null),
  /**
   * Other people who are not independent of this invoice. Feature 9 supplies whoever onboarded the
   * vendor or requested / verified its last bank change (vendor-master maintenance and invoice
   * approval must be separate); intake can supply "this purchase is for" (an assistant requesting
   * for their boss must not route the approval to that boss).
   */
  conflicts: z.array(ExcludedApprover.omit({ kind: true })).default([]),
  /** Invoice currency, amount and the rate core/fx used. Re-checked here: routing on an
   *  unconverted USD amount would under-approve. */
  currency: z.string().regex(/^[A-Z]{3}$/),
  totalCents: Cents,
  fxRateToCad: z.number().positive().finite(),
  /** Negative for a credit note. */
  totalCadCents: Cents,
  /** Departments the coded lines charge. Others than departmentId are surfaced to approvers. */
  lineDepartmentIds: z.array(z.string()).default([]),
  /** The department's spend so far this fiscal year, before this invoice (CAD cents), if known. */
  departmentSpendYtdCadCents: Cents.nullable().default(null),
  /** All flags on the invoice; resolved ones are ignored. */
  flags: z.array(Flag).default([]),
});
export type ApprovalInput = z.input<typeof ApprovalInput>;
export type ParsedApprovalInput = z.output<typeof ApprovalInput>;

/**
 * Flag that bumps the routing amount. Validation (feature 4) owns split detection and must put
 * the combined total in `evidence.combinedCadCents` (integer cents). Without it, approvals adds a
 * finance-manager step rather than guess.
 */
export const SPLIT_FLAG_CODE = "SPLIT_INVOICE_SUSPECTED";

// ---------------------------------------------------------------------------------------------
// Output: the plan. One ApprovalStep = one `approval_steps` row for this invoice version.
// ---------------------------------------------------------------------------------------------
export const PolicyReason = z.object({
  policyId: z.string().nullable(),
  message: z.string(),
});
export type PolicyReason = z.infer<typeof PolicyReason>;

export const StepDecision = z.enum(["pending", "approved", "rejected"]);
export type StepDecision = z.infer<typeof StepDecision>;

export const ApprovalStep = z.object({
  seq: z.number().int().positive(),
  role: ApproverRole,
  /** Other roles this one signature also covers, when nobody else was eligible (e.g. CFO = controller). */
  alsoCovers: z.array(ApproverRole),
  /** The policy that created the step (approval_steps.policy_id) and its version; null for a
   *  built-in safety rule (e.g. a suspected split with no combined total). */
  policyId: z.string().nullable(),
  policyVersion: z.number().int().positive().nullable(),
  /** Every policy that wants this step, each with a sentence the UI can show. */
  reasons: z.array(PolicyReason).min(1),
  /** Who the policy pointed at, before delegation or escalation. */
  routedTo: z.string(),
  /** Who must act, as resolved at routing. At decision time effectiveAssignee() re-resolves. */
  assignedTo: z.string(),
  /** Set when assignedTo is the named delegate of an on-leave approver (P08). */
  onBehalfOf: z.string().nullable(),
  /** How routedTo became assignedTo (delegation, escalation). Empty when they are the same. */
  resolution: z.array(PolicyReason),
  decision: StepDecision,
  actedBy: z.string().nullable(),
  /** Who they were and what authority they had WHEN they acted: an auditor asks months later,
   *  after titles and limits have changed. */
  actedAs: z.object({ fullName: z.string(), role: z.string(), approvalLimitCents: Cents }).nullable(),
  /** Exception codes (plan.attention) the approver explicitly acknowledged when approving. */
  acknowledgedFlags: z.array(z.string()),
  comment: z.string().nullable(),
  decidedAt: z.string().nullable(),
});
export type ApprovalStep = z.infer<typeof ApprovalStep>;

export const ApprovalOutcome = z.enum([
  /** Fire `submit` → PendingApproval with these steps. */
  "route",
  /** Fire `hold` → OnHold; holdReasons says why. */
  "hold",
  /** Stay in InReview: open `block` flags must be resolved first (submit guard). */
  "blocked",
]);
export type ApprovalOutcome = z.infer<typeof ApprovalOutcome>;

/** An exception the approvers must explicitly acknowledge before approving. */
export const AttentionFlag = z.object({
  code: z.string(),
  severity: FlagSeverity,
  status: FlagStatus,
  message: z.string(),
});
export type AttentionFlag = z.infer<typeof AttentionFlag>;

export const ApprovalPlan = z.object({
  /** Set by the approvals store when the plan is saved; absent on a plan that was never saved.
   *  A decision is only saved onto the plan it was made on. */
  planId: z.string().optional(),
  invoiceId: z.string(),
  invoiceVersion: z.number().int().positive(),
  departmentId: z.string(),
  /** When the plan was made; step 1 has been waiting since then (aging, reminders). */
  routedAt: z.string(),
  outcome: ApprovalOutcome,
  /** |total| in CAD cents, or the split-invoice combined total if that is higher. */
  routingCadCents: NonNegativeCents,
  /**
   * What the approvers are approving. Payments (feature 7) must not pay a different payee or more
   * than totalCents in `currency`; reapprovalReasons() decides whether an edit keeps the approvals.
   */
  basis: z.object({
    vendorId: z.string().nullable(),
    currency: z.string(),
    totalCents: Cents,
    totalCadCents: Cents,
    requesterId: z.string(),
    poId: z.string().nullable(),
  }),
  steps: z.array(ApprovalStep),
  /** People who may not sign any step of this invoice, and why. */
  excludedApprovers: z.array(ExcludedApprover),
  /** Unresolved warnings and overridden flags: approving requires acknowledging each code. */
  attention: z.array(AttentionFlag),
  holdReasons: z.array(PolicyReason),
  /** Context for approvers that does not change the route (credit note, earlier rejections, …). */
  notes: z.array(PolicyReason),
});
export type ApprovalPlan = z.infer<typeof ApprovalPlan>;
