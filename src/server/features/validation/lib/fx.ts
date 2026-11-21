/**
 * USD → CAD at the invoice-date rate (docs/rules/money-and-tax.md): the rate for that date, or
 * the nearest earlier date within a lookback window. Never a later date, never a default.
 * Validation-local until src/server/core/fx.ts exists.
 */
import type { FxRate } from "../context";
import { daysBetween } from "./dates";
import { mulRate } from "./money";

export function rateFor(date: string, rates: readonly FxRate[], lookbackDays: number): FxRate | null {
  let best: FxRate | null = null;
  for (const r of rates) {
    if (r.date > date) continue;
    if (daysBetween(r.date, date) > lookbackDays) continue;
    if (!best || r.date > best.date) best = r;
  }
  return best;
}

/** Converts to CAD cents. CAD passes through; USD needs a rate; anything else returns null. */
export function toCadCents(cents: number, currency: string, rate: FxRate | null): number | null {
  if (currency === "CAD") return cents;
  if (currency === "USD" && rate) return mulRate(cents, rate.usdToCad);
  return null;
}
