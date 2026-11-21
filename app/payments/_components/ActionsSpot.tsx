// TEMP: placeholder where the payment session's Schedule / Release / Retry button goes after we
// merge Katie. Those buttons carry the real rules; the dashboard never builds its own.

import type { DashboardRole } from "../_lib/access";
import type { PaymentStatus } from "../_lib/types";

export function ActionsSpot({ label }: { label: string }) {
  return (
    <span
      title="The payment session's button goes here after merging"
      className="inline-flex items-center rounded-md border border-dashed border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-400"
    >
      {label}
    </span>
  );
}

/** Which button belongs in a row for this role, or null for none. */
export function actionFor(role: DashboardRole, status: PaymentStatus | "awaiting"): string | null {
  const releaser = role === "finance_manager" || role === "controller";
  switch (status) {
    case "awaiting":
      return role === "clerk" || role === "controller" ? "Schedule" : null;
    case "scheduled":
      return releaser ? "Release" : null;
    case "failed":
      return role === "clerk" || releaser ? "Retry" : null;
    default:
      return null;
  }
}
