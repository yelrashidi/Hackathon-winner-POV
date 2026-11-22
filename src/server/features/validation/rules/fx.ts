import type { Flag } from "@/contracts/flag";
import { VALIDATION_CONFIG } from "../config";
import { makeFlag } from "../flag";
import { toRatio } from "../lib/money";
import type { Rule } from "./types";

/**
 * Foreign-currency invoices need a USD→CAD rate for the invoice date (or the nearest earlier
 * date within the lookback): every limit is compared in CAD. A rate printed on the invoice is
 * checked against the table.
 */
export const fxRule: Rule = (input, _ctx, d) => {
  const flags: Flag[] = [];
  const cur = d.currency;
  if (!cur || cur === "CAD" || !VALIDATION_CONFIG.supportedCurrencies.includes(cur)) return flags;
  const date = input.invoiceDate ?? input.receivedDate;

  if (!d.fxRate) {
    flags.push(
      makeFlag(
        "FX_RATE_MISSING",
        `No ${cur}→CAD rate on ${date} or within ${VALIDATION_CONFIG.fxLookbackDays} days before it — add the rate so CAD limits can be applied`,
        { field: "currency", actual: cur, date, source: "fx_rates" },
      ),
    );
    return flags;
  }

  if (input.statedFxRate !== null) {
    const stated = toRatio(input.statedFxRate);
    const table = toRatio(d.fxRate.usdToCad);
    const tol = toRatio(VALIDATION_CONFIG.fxTolerancePct);
    // |stated − table| / table > tol%   ⇔   |s·tden − t·sden| · 100 · toldenominator > tolnum · t · sden
    const diff = stated.num * table.den - table.num * stated.den;
    const absDiff = diff < 0n ? -diff : diff;
    if (absDiff * 100n * tol.den > tol.num * table.num * stated.den) {
      flags.push(
        makeFlag(
          "FX_RATE_MISMATCH",
          `Invoice states ${cur}→CAD ${input.statedFxRate}; the rate table has ${d.fxRate.usdToCad} for ${d.fxRate.date} (more than ${VALIDATION_CONFIG.fxTolerancePct}% apart) — CAD amounts use the table rate`,
          { field: "statedFxRate", actual: input.statedFxRate, expected: d.fxRate.usdToCad, rateDate: d.fxRate.date, source: "fx_rates" },
        ),
      );
    }
  }
  return flags;
};
