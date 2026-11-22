import type { AuditInvoiceDetail, Person } from "@/contracts/audit-view";

/**
 * "Who did what" — the people chain an auditor asks about first, in order:
 *
 *   Requested → Checked → Approved (one entry per approval step) → Scheduled → Released
 *
 * Built only from the audit detail (requester, timeline, approval steps, payment attempts), so it
 * is the same for imported history and live invoices. Where the history does not say who did a
 * step (e.g. the dataset never recorded who checked an old invoice), the step says so — it never guesses.
 */

export type ChainStepKind = "requested" | "checked" | "approved" | "scheduled" | "released";

/**
 * done          someone did it (person + when)
 * waiting       it is this step's turn (person = who it is waiting on, if known)
 * not_yet       an earlier step has not happened yet
 * not_recorded  it happened, but the record does not say who (imported history)
 * rejected      the approver said no
 * failed        the payment failed or was cancelled
 */
export type ChainStepState = "done" | "waiting" | "not_yet" | "not_recorded" | "rejected" | "failed";

export interface ChainStep {
  kind: ChainStepKind;
  state: ChainStepState;
  /** One readable sentence: "Jordan Okafor (AP Clerk) did the checks and sent it to approval". */
  summary: string;
  person: Person | null;
  onBehalfOf: Person | null;
  /** ISO timestamp or date of the action; null when not known. */
  at: string | null;
  /** Approval steps only: the step's role, e.g. "dept_manager". */
  stepRole?: string;
}

const ROLE_NAMES: Record<string, string> = {
  employee: "Employee",
  ap_clerk: "AP Clerk",
  approver: "Manager",
  finance_manager: "Finance Manager",
  controller_admin: "Controller",
  auditor: "Auditor",
  system: "System",
};
const who = (p: Person) => `${p.name}${ROLE_NAMES[p.role] ? ` (${ROLE_NAMES[p.role]})` : ""}`;

/** Statuses at which the invoice has passed the clerk's checks. */
const PAST_CHECKS = ["PendingApproval", "Approved", "PaymentScheduled", "Paid", "Closed"];
const APPROVED_OR_LATER = ["Approved", "PaymentScheduled", "Paid", "Closed"];

export function whoDidWhat(d: AuditInvoiceDetail, opts: { stepLabel?: (role: string) => string } = {}): ChainStep[] {
  const inv = d.invoice;
  const label = opts.stepLabel ?? ((r: string) => r.replace(/_/g, " "));
  const steps: ChainStep[] = [];
  const imported = d.timeline.some((e) => e.imported);

  // 1. Requested
  const created = d.timeline.find((e) => e.action === "invoice.created" || e.action === "invoice.imported");
  steps.push(
    inv.requester
      ? { kind: "requested", state: "done", summary: `${who(inv.requester)} requested it`, person: inv.requester, onBehalfOf: null, at: inv.invoiceDate ?? created?.occurredAt ?? null }
      : { kind: "requested", state: PAST_CHECKS.includes(inv.status) ? "not_recorded" : "waiting", summary: PAST_CHECKS.includes(inv.status) ? "Requester not recorded" : "No requester yet — the AP Clerk sets it during the checks", person: null, onBehalfOf: null, at: null },
  );

  // 2. Checked: whoever finished the checks and sent it to approval (the latest submission counts).
  const submitted = [...d.timeline].reverse().find((e) => e.action === "invoice.status_changed" && (e.after as { status?: string } | null)?.status === "PendingApproval");
  if (submitted) {
    steps.push({ kind: "checked", state: "done", summary: `${who(submitted.actor)} did the checks and sent it to approval`, person: submitted.actor, onBehalfOf: null, at: submitted.occurredAt });
  } else if (PAST_CHECKS.includes(inv.status) || imported) {
    steps.push({ kind: "checked", state: "not_recorded", summary: "Checks not recorded — imported from history, which does not say who checked it", person: null, onBehalfOf: null, at: null });
  } else {
    const working = [...d.timeline].reverse().find((e) => ["invoice.line_coded", "invoice.edited", "flag.resolved", "flag.overridden"].includes(e.action) && e.actor.role !== "system");
    steps.push({
      kind: "checked",
      state: inv.status === "Voided" ? "not_yet" : "waiting",
      summary: inv.status === "Voided" ? "Voided before the checks were finished" : working ? `Checks in progress — last worked on by ${who(working.actor)}` : "Waiting for the AP Clerk's checks",
      person: working?.actor ?? null,
      onBehalfOf: null,
      at: working?.occurredAt ?? null,
    });
  }

  // 3. Approved: the latest approval round, one entry per step.
  const round = d.approvals[d.approvals.length - 1];
  if (round && round.steps.length) {
    for (const s of round.steps) {
      const role = label(s.role);
      if (s.decision === "approved" && s.actedBy) {
        steps.push({ kind: "approved", state: "done", summary: `${who(s.actedBy)} approved it as ${role}${s.onBehalfOf ? ` on behalf of ${s.onBehalfOf.name}` : ""}`, person: s.actedBy, onBehalfOf: s.onBehalfOf, at: s.decidedAt, stepRole: s.role });
      } else if (s.decision === "rejected" && s.actedBy) {
        steps.push({ kind: "approved", state: "rejected", summary: `${who(s.actedBy)} rejected it as ${role}${s.onBehalfOf ? ` on behalf of ${s.onBehalfOf.name}` : ""}`, person: s.actedBy, onBehalfOf: s.onBehalfOf, at: s.decidedAt, stepRole: s.role });
      } else if (s.decision === "pending") {
        steps.push({ kind: "approved", state: "waiting", summary: `Waiting on ${s.assignedTo ? who(s.assignedTo) : "an approver"} to approve as ${role}`, person: s.assignedTo, onBehalfOf: null, at: null, stepRole: s.role });
      } else {
        steps.push({ kind: "approved", state: "not_yet", summary: `${role}: ${s.decision}`, person: s.assignedTo, onBehalfOf: null, at: s.decidedAt, stepRole: s.role });
      }
    }
  } else if (APPROVED_OR_LATER.includes(inv.status)) {
    steps.push({ kind: "approved", state: "not_recorded", summary: "Approval not recorded", person: null, onBehalfOf: null, at: null });
  } else {
    steps.push({ kind: "approved", state: inv.status === "PendingApproval" ? "waiting" : "not_yet", summary: "Not sent to approval yet", person: null, onBehalfOf: null, at: null });
  }

  // 4–5. Scheduled and released: the latest payment attempt (a retry is a new attempt).
  const pay = d.payments[d.payments.length - 1];
  if (!pay) {
    const turn = inv.status === "Approved";
    steps.push({ kind: "scheduled", state: turn ? "waiting" : "not_yet", summary: turn ? "Approved — waiting for the AP Clerk to schedule the payment" : "Payment not scheduled yet", person: null, onBehalfOf: null, at: null });
    steps.push({ kind: "released", state: "not_yet", summary: "Payment not released yet", person: null, onBehalfOf: null, at: null });
    return steps;
  }
  const scheduledEvent = [...d.timeline].reverse().find((e) => e.action === "payment.scheduled" && e.paymentId === pay.paymentId);
  const attempt = d.payments.length > 1 ? ` (attempt ${pay.attemptNo})` : "";
  steps.push(
    pay.preparedBy
      ? { kind: "scheduled", state: "done", summary: `${who(pay.preparedBy)} scheduled the payment${pay.scheduledDate ? ` for ${pay.scheduledDate}` : ""}${attempt}`, person: pay.preparedBy, onBehalfOf: null, at: scheduledEvent?.occurredAt ?? pay.scheduledDate }
      : { kind: "scheduled", state: "not_recorded", summary: `Payment scheduled${pay.scheduledDate ? ` for ${pay.scheduledDate}` : ""} — who scheduled it is not recorded`, person: null, onBehalfOf: null, at: pay.scheduledDate },
  );

  if (pay.status === "failed" || pay.status === "cancelled") {
    const why = pay.status === "failed" ? `failed${pay.failureCode ? ` (${pay.failureCode})` : ""}` : `cancelled${pay.cancelReason ? `: “${pay.cancelReason}”` : ""}`;
    steps.push({ kind: "released", state: "failed", summary: `${pay.releasedBy ? `${who(pay.releasedBy)} released it; the payment ` : "The payment "}${why}`, person: pay.releasedBy ?? pay.cancelledBy, onBehalfOf: null, at: pay.failedAt ?? pay.cancelledAt ?? pay.releasedAt });
  } else if (pay.releasedBy) {
    const paid = pay.paidDate ?? pay.settledAt;
    steps.push({ kind: "released", state: "done", summary: `${who(pay.releasedBy)} released it${paid ? ` — paid ${String(paid).slice(0, 10)}` : ""}`, person: pay.releasedBy, onBehalfOf: null, at: pay.releasedAt ?? pay.paidDate });
  } else {
    steps.push({ kind: "released", state: "waiting", summary: "Scheduled — waiting for the Finance Manager to release it (the Controller above $100,000)", person: null, onBehalfOf: null, at: null });
  }
  return steps;
}
