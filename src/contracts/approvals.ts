import { z } from "zod";
import { Flag } from "./flag";

/**
 * Feature 6 — approvals. Input from the analysis pass (stages 1–5), the structured policy rows
 * an admin edits, and the plan approvals produces (persisted to `approval_steps`).
 * Rules for changing this file: docs/rules/contracts.md.
 */

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
  z.object({ kind: z.literal("amount_up_to"), cadCents: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("amount_over"), cadCents: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("vendor_new_or_pending"), newVendorDays: z.number().int().positive() }),
  z.object({ kind: z.literal("vendor_category"), category: z.string().min(1) }),
  /** Fires when the invoice has an OPEN flag with this code (e.g. PO_OVER_BALANCE from validation). */
  z.object({ kind: z.literal("open_flag"), code: z.string().regex(/^[A-Z][A-Z0-9_]*$/) }),
  z.object({ kind: z.literal("po_required_missing") }),
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

export const ApprovalPolicy = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  active: z.boolean(),
  ruleType: z.enum(["approval", "payment_release", "match"]),
  /** Higher wins when several `chain` policies match. */
  priority: z.number().int(),
  conditions: PolicyCondition,
  steps: PolicyEffect,
  description: z.string(),
});
export type ApprovalPolicy = z.infer<typeof ApprovalPolicy>;

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
  requesterId: z.string().min(1),
  /** The AP clerk who keyed / submitted it, if not the requester. Cannot approve either. */
  submittedBy: z.string().nullable().default(null),
  poId: z.string().nullable().default(null),
  /** Converted at the invoice-date rate by core/fx. Negative for a credit note. */
  totalCadCents: z.number().int(),
  /** All flags on the invoice; approvals only looks at `open` ones. */
  flags: z.array(Flag).default([]),
});
export type ApprovalInput = z.input<typeof ApprovalInput>;
export type ParsedApprovalInput = z.output<typeof ApprovalInput>;

/**
 * Flag that bumps the routing amount. Validation (feature 4) owns split detection and must put
 * the combined total in `evidence.combinedCadCents` (integer cents).
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
  /** The policy that created the step (approval_steps.policy_id) and its version. */
  policyId: z.string(),
  policyVersion: z.number().int().positive(),
  /** Every policy that wants this step, each with a sentence the UI can show. */
  reasons: z.array(PolicyReason).min(1),
  /** Who the policy pointed at, before delegation or escalation. */
  routedTo: z.string(),
  /** Who must act. */
  assignedTo: z.string(),
  /** Set when assignedTo is the named delegate of an on-leave approver (P08). */
  onBehalfOf: z.string().nullable(),
  /** How routedTo became assignedTo (delegation, escalation). Empty when they are the same. */
  resolution: z.array(PolicyReason),
  decision: StepDecision,
  actedBy: z.string().nullable(),
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

export const ApprovalPlan = z.object({
  invoiceId: z.string(),
  invoiceVersion: z.number().int().positive(),
  outcome: ApprovalOutcome,
  /** |total| in CAD cents, or the split-invoice combined total if that is higher. */
  routingCadCents: z.number().int().nonnegative(),
  steps: z.array(ApprovalStep),
  holdReasons: z.array(PolicyReason),
  /** Context for approvers that does not change the route (credit note, terminated requester). */
  notes: z.array(PolicyReason),
});
export type ApprovalPlan = z.infer<typeof ApprovalPlan>;
