import "server-only";

// TEMP: display copy of the payment session's release rules (policies P09–P11 and separation of
// duties), so the dashboard can say why someone can't release. It decides what to SHOW only;
// the payment session's server code is what actually refuses a release. Swap for its exported
// check when we merge Katie, so the rules exist once.

import { listUsers, type DirectoryUser } from "@/server/session/users";
import { openFlags, type PaymentRow } from "./data";
import type { PaymentFlag } from "./types";
import { formatMoney } from "./format";

/** A Finance Manager releases up to $100,000.00 CAD; above that needs a Controller. */
export const FM_RELEASE_LIMIT_CAD_CENTS = 10_000_000;

export type BlockerCode =
  | "NOT_A_RELEASER"
  | "NEEDS_CONTROLLER"
  | "APPROVED_IT"
  | "REQUESTED_IT"
  | "SCHEDULED_IT"
  | "FRAUD_HOLD"
  | "BANK_NOT_PAYABLE";

export type Blocker = { code: BlockerCode; message: string };

/** Why this person can't release this scheduled payment. Empty means they can. */
export function releaseBlockers(user: DirectoryUser | null, row: PaymentRow): Blocker[] {
  if (!user || (user.role !== "finance_manager" && user.role !== "controller_admin")) {
    return [{ code: "NOT_A_RELEASER", message: "Only a Finance Manager or Controller can release payments." }];
  }

  const blockers: Blocker[] = [];
  const { invoice, current } = row;
  const open = openFlags(row);

  if (open.some((f) => f.urgency === "critical")) {
    blockers.push({ code: "FRAUD_HOLD", message: "Stopped: fraud hold on this supplier. Controller must review." });
  }
  if (open.some((f) => f.urgency === "high" && f.scope === "supplier")) {
    blockers.push({
      code: "BANK_NOT_PAYABLE",
      message: "A payment to this supplier's bank account failed. It can't be paid until new bank details are verified.",
    });
  }

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

/**
 * TEMP: who may clear a flag (docs/payment-data.md). Critical: Controller role only, never whoever
 * scheduled the payment that raised it. High and low: AP Clerk, Finance Manager or Controller.
 */
export function canClearFlag(user: DirectoryUser | null, flag: PaymentFlag, row: PaymentRow): boolean {
  if (!user || flag.clearedAt !== null) return false;
  if (flag.urgency === "critical") {
    const raisedBy = row.attempts.find((a) => a.paymentId === flag.paymentId) ?? row.current;
    return user.role === "controller_admin" && raisedBy.preparedBy.userId !== user.id;
  }
  return user.role === "ap_clerk" || user.role === "finance_manager" || user.role === "controller_admin";
}
