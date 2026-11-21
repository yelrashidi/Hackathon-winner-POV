// TEMP: copy of the failure grouping in docs/payment-decisions.md. Swap for the payment
// session's export once it exists so both sides read one list.

import type { FailureCode } from "./types";

export type FailureGroup = "retry" | "fix_bank_details" | "escalate";

type FailureReason = {
  group: FailureGroup;
  message: string;
  nextStep: string;
};

export const FAILURE_REASONS: Record<FailureCode, FailureReason> = {
  BANK_ERROR: {
    group: "retry",
    message: "The bank had a temporary error and did not process the transfer.",
    nextStep: "Retry the payment.",
  },
  INSUFFICIENT_FUNDS: {
    group: "retry",
    message: "Harborline's account did not have enough funds when the transfer ran.",
    nextStep: "Confirm funds are available, then retry.",
  },
  ACCOUNT_CLOSED: {
    group: "fix_bank_details",
    message: "The supplier's bank account is closed.",
    nextStep:
      "Hold other payments to this account, get new details from the supplier's contact on file, and have a second person verify them before retrying.",
  },
  INVALID_ACCOUNT: {
    group: "fix_bank_details",
    message: "The account number does not exist at the supplier's bank.",
    nextStep: "Correct and verify the supplier's bank details, then retry.",
  },
  INVALID_BRANCH: {
    group: "fix_bank_details",
    message: "The transit (branch) number is not valid.",
    nextStep: "Correct and verify the supplier's bank details, then retry.",
  },
  NAME_MISMATCH: {
    group: "fix_bank_details",
    message: "The account holder's name does not match the supplier's legal name.",
    nextStep: "Confirm the account belongs to the supplier and verify it, then retry.",
  },
  CURRENCY_NOT_SUPPORTED: {
    group: "fix_bank_details",
    message: "The supplier's account cannot receive this currency.",
    nextStep: "Get and verify an account that accepts this currency, then retry.",
  },
  ACCOUNT_FROZEN: {
    group: "escalate",
    message: "The supplier's account is frozen by their bank.",
    nextStep: "Do not retry. The Controller reviews the supplier.",
  },
  FRAUD_HOLD: {
    group: "escalate",
    message: "The bank held the transfer as possible fraud.",
    nextStep: "Do not retry. The Controller reviews the payment and the supplier's bank details.",
  },
};
