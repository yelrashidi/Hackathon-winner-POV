// TEMP: approvals — loads the dataset's approval history (approvals.csv) into Youssef's approval
// store with his importApprovalPlan(), so payments can ask approvals the real way
// (getApprovalPlans / approversOf / getCurrentApprovalPlan). Remove once the approval flow itself
// fills the store (docs/payment-assumptions.md).

import type { ApprovalPlan, ApproverRole } from "@/contracts/approvals";
import { InMemoryApprovalStore, importApprovalPlan, setDefaultApprovalStore } from "@/server/features/approvals";
import { dollarsToCents, readCsv } from "./csv";

const OPEN_STATUSES = new Set(["approved", "scheduled"]);
const ROLES: ReadonlySet<string> = new Set<ApproverRole>(["dept_manager", "finance_manager", "controller_admin", "cfo"]);

/** One approval plan per open invoice, rebuilt from its approval history rows. */
export function historicalPlans(): ApprovalPlan[] {
  const users = new Map(
    readCsv("users.csv", ["user_id", "full_name", "role", "approval_limit_cad"]).map((u) => [u.user_id, u]),
  );
  const rows = readCsv("approvals.csv", ["invoice_id", "step_no", "approver_user_id", "approver_role", "action", "acted_at", "comment"]);
  const invoices = readCsv("invoices.csv", [
    "invoice_id", "status", "vendor_id", "currency", "total", "total_cad", "department_id", "requester_user_id", "po_id", "received_date",
  ]);

  const plans: ApprovalPlan[] = [];
  for (const inv of invoices) {
    if (!OPEN_STATUSES.has(inv.status)) continue;
    const history = rows.filter((r) => r.invoice_id === inv.invoice_id).sort((a, b) => Number(a.step_no) - Number(b.step_no));
    const totalCents = dollarsToCents(inv.total);
    const totalCadCents = dollarsToCents(inv.total_cad);
    plans.push({
      invoiceId: inv.invoice_id,
      invoiceVersion: 1,
      departmentId: inv.department_id,
      routedAt: inv.received_date,
      outcome: "route",
      routingCadCents: Math.abs(totalCadCents),
      basis: {
        vendorId: inv.vendor_id || null,
        currency: inv.currency,
        totalCents,
        totalCadCents,
        requesterId: inv.requester_user_id,
        poId: inv.po_id || null,
      },
      steps: history.map((r) => {
        if (!ROLES.has(r.approver_role)) throw new Error(`approvals.csv: unknown approver_role "${r.approver_role}" on ${r.invoice_id}`);
        const user = users.get(r.approver_user_id);
        return {
          seq: Number(r.step_no),
          role: r.approver_role as ApproverRole,
          alsoCovers: [],
          policyId: null,
          policyVersion: null,
          reasons: [{ policyId: null, message: `Imported from the dataset's approval history (approvals.csv, step ${r.step_no}).` }],
          routedTo: r.approver_user_id,
          assignedTo: r.approver_user_id,
          onBehalfOf: null,
          resolution: [],
          decision: r.action === "approved" ? ("approved" as const) : r.action === "rejected" ? ("rejected" as const) : ("pending" as const),
          actedBy: r.action ? r.approver_user_id : null,
          actedAs: user
            ? { fullName: user.full_name, role: user.role, approvalLimitCents: dollarsToCents(user.approval_limit_cad || "0") }
            : null,
          acknowledgedFlags: [],
          comment: r.comment || null,
          decidedAt: r.acted_at || null,
        };
      }),
      excludedApprovers: [],
      attention: [],
      holdReasons: [],
      notes: [{ policyId: null, message: "Seeded by payments from approvals.csv until the approval flow fills this store." }],
    });
  }
  return plans;
}

/** A fresh approval store holding the dataset's history. Called on first use and on demo reset. */
export async function seedApprovalStore(): Promise<void> {
  setDefaultApprovalStore(new InMemoryApprovalStore());
  for (const plan of historicalPlans()) await importApprovalPlan(plan);
}
