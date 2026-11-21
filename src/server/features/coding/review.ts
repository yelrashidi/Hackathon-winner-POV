import type { LineCoding } from "@/contracts/coding";
import type { Flag } from "@/contracts/flag";
import { codingFlag } from "./codes";
import type { CodingContext, GlAccountRef } from "./context";
import { clip, fold, formatMoney } from "./text";

/**
 * Accounting judgments a coder should be prompted on, for whatever account the line ends up on
 * (the suggestion, or what a person picked).
 *
 * Capitalisation: the chart itself says 6220 is for "Expense items under $1,000 per unit"; the
 * limit is read from the account's notes, never hard-coded. The history contains desks at
 * $1,189.75 a unit expensed anyway — exactly what this flag is for.
 * Prepaid: a line that covers a year ("annual", "12 months", "annuel") expensed in one month
 * overstates that month. The chart has no prepaid account, so this only prompts.
 */

const PER_UNIT_LIMIT = /under\s+\$?\s*([\d,]+(?:\.\d{1,2})?)\s+per\s+unit/i;
const MULTI_PERIOD = /\b(annual|yearly|12[\s-]?months?|twelve months|annuel(le)?|annee)\b/;

/** "Expense items under $1,000 per unit" → 100000 (cents); null when the notes set no limit. */
export function perUnitLimitCents(account: GlAccountRef): number | null {
  const m = account.notes ? PER_UNIT_LIMIT.exec(account.notes) : null;
  if (!m) return null;
  const value = Number(m[1]!.replace(/,/g, ""));
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

export function reviewLine(
  line: Pick<LineCoding, "lineNo" | "description" | "unitPriceCents" | "amountCents" | "glAccount">,
  ctx: CodingContext,
  currency: string | null,
): Flag[] {
  const flags: Flag[] = [];
  if (line.amountCents <= 0) return flags; // discounts and credits never need either prompt
  const account = line.glAccount ? ctx.glAccounts.get(line.glAccount) : undefined;
  const limit = account ? perUnitLimitCents(account) : null;
  if (account && limit !== null && line.unitPriceCents >= limit) {
    flags.push(
      codingFlag(
        "CODING_CAPITALIZE_REVIEW",
        `Line ${line.lineNo} "${clip(line.description)}": ${formatMoney(line.unitPriceCents, currency)} per unit is at or over the ${formatMoney(limit, null)} limit of ${account.number} ${account.name} ("${account.notes}"); it may need to be capitalised as an asset instead.`,
        { field: "lines", lineNo: line.lineNo, unitPriceCents: line.unitPriceCents, limitCents: limit, glAccount: account.number },
      ),
    );
  }
  if (MULTI_PERIOD.test(fold(line.description))) {
    flags.push(
      codingFlag(
        "CODING_PREPAID_REVIEW",
        `Line ${line.lineNo} "${clip(line.description)}" covers more than this month; consider spreading it over the period it covers instead of expensing ${formatMoney(line.amountCents, currency)} at once.`,
        { field: "lines", lineNo: line.lineNo },
      ),
    );
  }
  return flags;
}
