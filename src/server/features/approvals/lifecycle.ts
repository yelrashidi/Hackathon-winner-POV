import { ApprovalInput, type ApprovalPlan, type ApprovalStep, type PolicyReason } from "@/contracts/approvals";
import { displayName, formatCad, type ApprovalContext } from "./directory";
import { currentStep } from "./decide";
import { effectiveAssignee, signersOf } from "./resolve";
import { planApprovals } from "./route";

/**
 * What happens to an invoice's approvals over time, after routing.
 *
 * reapprovalReasons — an invoice is edited after (or while) it is approved. Real AP's classic gap:
 *   the approved amount and the paid amount drift apart (freight added, a "corrected" invoice, a
 *   new bank-detail letter with a new payee). Returns why the edit voids the approvals, or [] if
 *   it does not. Non-empty → bump invoices.version (checkDecision then answers STALE_PLAN) and
 *   resubmit. Paying LESS than approved never needs re-approval.
 *
 * approvalAging — approvals that sit. In the history, 72 of 426 invoices were first approved
 *   after their due date. A scheduled job calls this to remind, and to warn the approver's
 *   manager, before the due date or an early-payment discount (2/10 net 30) is lost. It only
 *   notifies: it never reassigns, so it cannot become a way around the approval rules.
 */

/** Amount increase allowed without re-approval: the lesser of 2% and $100 (freight, rounding). */
export const REAPPROVAL_TOLERANCE = { pct: 0.02, maxCents: 10_000 } as const;

export function reapprovalReasons(approved: ApprovalPlan, rawEdited: ApprovalInput, ctx: ApprovalContext): PolicyReason[] {
  const edited = ApprovalInput.parse(rawEdited);
  const basis = approved.basis;
  const out: PolicyReason[] = [];
  const why = (message: string) => out.push({ policyId: null, message });
  const vendorName = (id: string | null) => (id ? (ctx.vendors.get(id)?.legalName ?? id) : "no vendor");

  if (edited.vendorId !== basis.vendorId) why(`The payee changed from ${vendorName(basis.vendorId)} to ${vendorName(edited.vendorId)}.`);
  if (edited.currency !== basis.currency) why(`The currency changed from ${basis.currency} to ${edited.currency}.`);
  if (edited.departmentId !== approved.departmentId) why(`The department changed from ${approved.departmentId} to ${edited.departmentId}.`);
  if (edited.requesterId !== basis.requesterId) {
    why(`The requester changed from ${displayName(ctx, basis.requesterId)} to ${displayName(ctx, edited.requesterId)}.`);
  }
  const poId = edited.poId?.trim() || null;
  if (poId !== basis.poId) why(`The purchase order changed from ${basis.poId ?? "none"} to ${poId ?? "none"}.`);

  if ((basis.totalCents < 0) !== (edited.totalCents < 0)) {
    why(`It changed from ${basis.totalCents < 0 ? "a credit note" : "an invoice"} to ${edited.totalCents < 0 ? "a credit note" : "an invoice"}.`);
  } else {
    // Positive invoice: more to pay. Credit note: less credit, so also more to pay. Same formula.
    const increase = edited.totalCents - basis.totalCents;
    const tolerance = Math.min(Math.round(Math.abs(basis.totalCents) * REAPPROVAL_TOLERANCE.pct), REAPPROVAL_TOLERANCE.maxCents);
    if (increase > tolerance) {
      why(
        `The amount owed went up by ${edited.currency} ${formatCad(increase).replace("$", "")}, from ${formatCad(basis.totalCents)} to ` +
          `${formatCad(edited.totalCents)}; more than the ${formatCad(tolerance)} allowed without re-approval.`,
      );
    }
  }

  // Would the edited invoice need anyone or anything the approvers did not cover?
  const next = planApprovals(edited, ctx);
  if (next.outcome !== "route") {
    why(`As edited it would not route for approval: ${next.holdReasons.map((r) => r.message).join(" ")}`);
    return out;
  }
  const covered = new Set(approved.steps.flatMap((s) => [s.role, ...s.alsoCovers]));
  for (const s of next.steps) {
    for (const role of [s.role, ...s.alsoCovers]) {
      if (!covered.has(role)) why(`It now also needs a ${role} approval: ${s.reasons.map((r) => r.message).join(" ")}`);
    }
  }
  const signed = signersOf(approved.steps);
  for (const ex of next.excludedApprovers) {
    if (signed.has(ex.userId)) why(`${displayName(ctx, ex.userId)} approved it but now ${ex.reason}.`);
  }
  const seen = new Set(approved.attention.map((a) => a.code));
  for (const a of next.attention) {
    if (!seen.has(a.code)) why(`New exception the approvers have not seen: ${a.code} (${a.message}).`);
  }
  return out;
}

// --- aging --------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

export interface AgingOptions {
  /** Remind the approver after this many business days waiting. */
  remindAfterBusinessDays?: number;
  /** Also notify the approver's manager after this many. */
  escalateAfterBusinessDays?: number;
  /** Invoice due date (ISO). Due within `urgentWithinDays` or past due → escalate. */
  dueDate?: string | null;
  /** Last day of an early-payment discount (ISO). Within `urgentWithinDays` → at least remind. */
  discountDeadline?: string | null;
  urgentWithinDays?: number;
}

export interface Aging {
  seq: number;
  role: ApprovalStep["role"];
  waitingOn: string | null;
  pendingSince: string;
  businessDaysWaiting: number;
  daysToDue: number | null;
  daysToDiscount: number | null;
  level: "on_time" | "remind" | "escalate";
  /** Who to notify: the approver, plus their manager when escalating. Never a reassignment. */
  notify: string[];
  message: string;
}

const utcDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

/** Weekdays after `from` up to and including `to` (UTC dates). Public holidays are not modelled. */
export function businessDaysBetween(from: Date, to: Date): number {
  const start = utcDay(from);
  const days = Math.round((utcDay(to) - start) / DAY_MS);
  if (!(days > 0)) return 0;
  let count = Math.floor(days / 7) * 5;
  for (let i = Math.floor(days / 7) * 7 + 1; i <= days; i++) {
    const weekday = new Date(start + i * DAY_MS).getUTCDay();
    if (weekday !== 0 && weekday !== 6) count++;
  }
  return count;
}

function daysUntil(now: Date, iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.round((utcDay(new Date(t)) - utcDay(now)) / DAY_MS);
}

export function approvalAging(
  plan: ApprovalPlan,
  now: Date,
  ctx: Pick<ApprovalContext, "users" | "departments" | "policies">,
  opts: AgingOptions = {},
): Aging | null {
  const { remindAfterBusinessDays = 2, escalateAfterBusinessDays = 5, urgentWithinDays = 3 } = opts;
  if (plan.outcome !== "route") return null;
  const step = currentStep(plan);
  if (!step) return null;

  const previous = plan.steps.filter((s) => s.seq < step.seq && s.decidedAt).sort((a, b) => b.seq - a.seq)[0];
  const pendingSince = previous?.decidedAt ?? plan.routedAt;
  const businessDaysWaiting = businessDaysBetween(new Date(pendingSince), now);
  const daysToDue = daysUntil(now, opts.dueDate);
  const daysToDiscount = daysUntil(now, opts.discountDeadline);

  const dueSoon = daysToDue !== null && daysToDue <= urgentWithinDays;
  const discountSoon = daysToDiscount !== null && daysToDiscount >= 0 && daysToDiscount <= urgentWithinDays;
  const level: Aging["level"] =
    businessDaysWaiting >= escalateAfterBusinessDays || dueSoon
      ? "escalate"
      : businessDaysWaiting >= remindAfterBusinessDays || discountSoon
        ? "remind"
        : "on_time";

  const waitingOn = effectiveAssignee(plan, step, ctx).assignee;
  const manager = waitingOn ? (ctx.users.get(waitingOn)?.managerId ?? null) : null;
  const notify = [waitingOn, level === "escalate" ? manager : null].filter((x): x is string => !!x);

  const parts = [`Step ${step.seq} (${step.role}) has waited ${businessDaysWaiting} business day${businessDaysWaiting === 1 ? "" : "s"} with ${displayName(ctx, waitingOn)}`];
  if (daysToDue !== null) parts.push(daysToDue < 0 ? `the invoice is ${-daysToDue} day(s) past due` : `the invoice is due in ${daysToDue} day(s)`);
  if (discountSoon) parts.push(`the early-payment discount ends in ${daysToDiscount} day(s)`);
  return {
    seq: step.seq,
    role: step.role,
    waitingOn,
    pendingSince,
    businessDaysWaiting,
    daysToDue,
    daysToDiscount,
    level,
    notify,
    message: `${parts.join("; ")}.`,
  };
}
