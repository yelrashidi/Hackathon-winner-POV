// TEMP: copy of FAILURE_REASONS from docs/payment-data.md. When we merge Katie, import it from
// "@/contracts/payment" instead.

import type { FailureCode, PaymentFailure, RetryRule, Urgency } from "./types";

type Reason = { retryRule: RetryRule; urgency: Urgency; message: string; nextStep: string };

export const FAILURE_REASONS: Record<FailureCode, Reason> = {
  BANK_ERROR: {
    retryRule: "RETRY_ALLOWED",
    urgency: "low",
    message: "The bank had a temporary error and did not process the transfer.",
    nextStep: "Retry the payment.",
  },
  INSUFFICIENT_FUNDS: {
    retryRule: "RETRY_ALLOWED",
    urgency: "low",
    message: "Harborline's account did not have enough funds when the transfer ran.",
    nextStep: "Confirm funds are available, then retry.",
  },
  ACCOUNT_CLOSED: {
    retryRule: "FIX_BANK_DETAILS",
    urgency: "high",
    message: "The supplier's bank account is closed.",
    nextStep:
      "Get new details from the supplier's contact on file, and have a second person verify them before retrying.",
  },
  INVALID_ACCOUNT: {
    retryRule: "FIX_BANK_DETAILS",
    urgency: "high",
    message: "The account number does not exist at the supplier's bank.",
    nextStep: "Correct and verify the supplier's bank details, then retry.",
  },
  INVALID_BRANCH: {
    retryRule: "FIX_BANK_DETAILS",
    urgency: "high",
    message: "The transit (branch) number is not valid.",
    nextStep: "Correct and verify the supplier's bank details, then retry.",
  },
  NAME_MISMATCH: {
    retryRule: "FIX_BANK_DETAILS",
    urgency: "high",
    message: "The account holder's name does not match the supplier's legal name.",
    nextStep: "Confirm the account belongs to the supplier and verify it, then retry.",
  },
  CURRENCY_NOT_SUPPORTED: {
    retryRule: "FIX_BANK_DETAILS",
    urgency: "high",
    message: "The supplier's account cannot receive this currency.",
    nextStep: "Get and verify an account that accepts this currency, then retry.",
  },
  ACCOUNT_FROZEN: {
    retryRule: "FIX_BANK_DETAILS",
    urgency: "high",
    message: "The supplier's account is frozen by their bank.",
    nextStep: "Get new bank details from the supplier and have a second person verify them before retrying.",
  },
  FRAUD_HOLD: {
    retryRule: "ESCALATE",
    urgency: "critical",
    message: "The bank held the transfer as possible fraud.",
    nextStep:
      "All payments to this supplier are stopped. The Controller reviews and clears the hold before any retry.",
  },
};

export function failureFor(code: FailureCode): PaymentFailure {
  return { code, ...FAILURE_REASONS[code] };
}
