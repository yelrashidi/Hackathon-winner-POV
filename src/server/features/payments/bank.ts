/**
 * The payment rail. Everything that "talks to the bank" goes through EftRail, so a real
 * provider (or a Stripe adapter, a nice-to-have) replaces SimulatedEft without touching the rules.
 * No real money moves: the simulated bank accepts every transfer and answers only when a
 * person presses "simulate settlement" and picks the outcome.
 */

import type { FailureCode } from "@/contracts/payment";

export interface EftTransfer {
  paymentId: string;
  vendorId: string;
  amountCents: number;
  currency: string;
  /** Server only: the full account number never leaves this layer. */
  institution: string | null;
  transit: string | null;
  account: string | null;
  last4: string;
}

export type SettlementOutcome = { kind: "settled" } | { kind: "failed"; code: FailureCode };

export interface EftRail {
  /** Hand the transfer to the bank. Returns the bank's reference. */
  send(transfer: EftTransfer): { reference: string };
}

export class SimulatedEft implements EftRail {
  private count = 0;

  send(transfer: EftTransfer): { reference: string } {
    this.count += 1;
    return { reference: `SIM-EFT-${transfer.paymentId}-${this.count}` };
  }
}

let rail: EftRail = new SimulatedEft();

export function getEftRail(): EftRail {
  return rail;
}

/** Swap the rail (tests, or a real provider later). */
export function setEftRail(next: EftRail): void {
  rail = next;
}
