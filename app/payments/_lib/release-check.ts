import "server-only";

// TEMP: display copy of the payment session's release rules (policies P09–P11 and separation of
// duties), so the dashboard can say why someone can't release. It decides what to SHOW only;
// the payment session's server code is what actually refuses a release. Swap for its exported
// check when we merge Katie, so the rules exist once.

import { listUsers, type DirectoryUser } from "@/server/session/users";
import type { PaymentRow } from "./data";
import { formatMoney } from "./format";

/** A Finance Manager releases up to $100,000.00 CAD; above that needs a Controller. */
export const FM_RELEASE_LIMIT_CAD_CENTS = 10_000_000;

export type BlockerCode =
  | "NOT_A_RELEASER"
  | "NEEDS_CONTROLLER"
  | "APPROVED_IT"
  | "REQUESTED_IT"
  | "SCHEDULED_IT";

export type Blocker = { code: BlockerCode; message: string };

/** Why this person can't release this scheduled payment. Empty means they can. */
export function releaseBlockers(user: DirectoryUser | null, row: PaymentRow): Blocker[] {
  if (!user || (user.role !== "finance_manager" && user.role !== "controller_admin")) {
    return [{ code: "NOT_A_RELEASER", message: "Only a Finance Manager or Controller can release payments." }];
  }

  const blockers: Blocker[] = [];
  const { invoice, current } = row;

  if (user.role === "finance_manager" && current.amountCadCents > FM_RELEASE_LIMIT_CAD_CENTS) {
    blockers.push({
      code: "NEEDS_CONTROLLER",
      message: `${formatMoney(current.amountCadCents)} CAD is over the Finance Manager limit of ${formatMoney(FM_RELEASE_LIMIT_CAD_CENTS)} CAD, so a Controller must release it.`,
    });
  }
  if (invoice.approvedBy.some((p) => p.userId === user.id)) {
    blockers.push({ code: "APPROVED_IT", message: "You approved this invoice, so someone else must release it." });
  }
  if (invoice.requestedBy.userId === user.id) {
    blockers.push({ code: "REQUESTED_IT", message: "You requested this invoice, so someone else must release it." });
  }
  if (current.preparedBy.userId === user.id) {
    blockers.push({ code: "SCHEDULED_IT", message: "You scheduled this payment, so someone else must release it." });
  }
  return blockers;
}

/** Everyone who could release this payment now: active Finance Managers and Controllers with no blocker. */
export function whoCanRelease(row: PaymentRow): DirectoryUser[] {
  return listUsers().filter(
    (u) =>
      (u.role === "finance_manager" || u.role === "controller_admin") &&
      u.status === "active" &&
      releaseBlockers(u, row).length === 0,
  );
}
