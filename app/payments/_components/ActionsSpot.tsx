// The real Schedule / Release / Retry / Schedule again buttons. Which one a row shows is UX (actionFor); whether it
// is allowed is decided on the server by the payments rules when the button is pressed.

import type { PaymentStatus } from "@/contracts/payment";
import type { DashboardRole } from "../_lib/access";
import { releaseAction, scheduleAction } from "../actions";
import { ActionForm } from "./ActionForm";

export type ActionLabel = "Schedule" | "Release" | "Retry" | "Schedule again";

export function PaymentAction({
  label,
  invoiceId,
  paymentId,
  align = "start",
}: {
  label: ActionLabel;
  invoiceId: string;
  paymentId?: string;
  align?: "start" | "end";
}) {
  if (label === "Release" && paymentId) {
    return <ActionForm action={releaseAction} label="Release" hidden={{ paymentId }} align={align} />;
  }
  if (label === "Retry" || label === "Schedule again") {
    const retry = label === "Retry" ? "1" : "again";
    return <ActionForm action={scheduleAction} label={label} hidden={{ invoiceId, retry }} align={align} />;
  }
  return <ActionForm action={scheduleAction} label="Schedule" hidden={{ invoiceId }} align={align} />;
}

/** Which button belongs in a row for this role, or null for none. */
export function actionFor(role: DashboardRole, status: PaymentStatus | "awaiting"): ActionLabel | null {
  const releaser = role === "finance_manager" || role === "controller";
  const preparer = role === "clerk" || role === "finance_manager";
  switch (status) {
    case "awaiting":
      // AP Clerks prepare (P09 note). The Finance Manager doesn't schedule: whoever schedules can't release, and they release.
      return role === "clerk" ? "Schedule" : null;
    case "scheduled":
      return releaser ? "Release" : null;
    case "failed":
      return preparer ? "Retry" : null;
    case "cancelled":
      // A cancelled payment didn't fail, so it isn't a "retry".
      return preparer ? "Schedule again" : null;
    default:
      return null;
  }
}
