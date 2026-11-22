import type { Flag } from "@/contracts/flag";
import type { ValidationInput, ValidationLine } from "@/contracts/validation";
import { VALIDATION_CONFIG } from "../config";
import type { ContractRef } from "../context";
import type { Derived } from "../derive";
import { makeFlag } from "../flag";
import { monthLabel, monthOf } from "../lib/dates";
import { comparePercent, formatMoney, mulPercent, mulQty, percentForDisplay, toRatio } from "../lib/money";
import { normalizeInvoiceNumber } from "../lib/text";
import type { Rule } from "./types";

/**
 * The vendor's contract on the invoice date, one check per billing term in contracts.csv:
 * fixed monthly fee (amount, billed twice, overage), hourly rate cap, fuel-surcharge cap and the
 * monthly not-to-exceed. Money is compared in the contract's currency, pre-tax.
 */

export type ContractState = "in_force" | "expired" | "not_started";
export interface ContractSelection {
  contract: ContractRef;
  state: ContractState;
}

/**
 * In force on the invoice DATE: inside start..end, or past the end of a contract that auto-renews
 * and is still active. The status column is today's status, so an invoice dated inside the term
 * of a contract that has since expired was billed under a contract in force.
 */
function inForce(c: ContractRef, date: string): boolean {
  if (date < c.startDate) return false;
  if (date <= c.endDate) return true;
  return c.autoRenew && c.status === "active";
}

export function selectContract(
  input: Pick<ValidationInput, "contractRef" | "invoiceDate">,
  d: Pick<Derived, "vendor">,
  contracts: readonly ContractRef[],
): ContractSelection | null {
  const date = input.invoiceDate;
  if (!date) return null;
  let pool: ContractRef[] = [];
  if (input.contractRef) {
    const ref = normalizeInvoiceNumber(input.contractRef);
    pool = contracts.filter((c) => normalizeInvoiceNumber(c.id) === ref);
  }
  if (pool.length === 0 && d.vendor) pool = contracts.filter((c) => c.vendorId === d.vendor!.id);
  if (pool.length === 0) return null;

  const live = pool.filter((c) => inForce(c, date)).sort((a, b) => b.startDate.localeCompare(a.startDate));
  if (live.length > 0) return { contract: live[0]!, state: "in_force" };

  const started = pool.filter((c) => c.startDate <= date).sort((a, b) => b.endDate.localeCompare(a.endDate));
  if (started.length > 0) return { contract: started[0]!, state: "expired" };
  const future = [...pool].sort((a, b) => a.startDate.localeCompare(b.startDate));
  return { contract: future[0]!, state: "not_started" };
}

const HOURLY_WORDS = /\b(hours?|hrs?|hourly|heures?|consult\w*|advisory|legal services|professional services)\b/i;
const NOT_HOURLY_WORDS = /\b(disbursements?|filing fees?|expenses?|d[ée]bours\w*|travel|mileage)\b/i;
const FUEL_WORDS = /\b(fuel surcharge|surcharge carburant|suppl[ée]ment carburant)\b/i;

/** An hourly line: says hours, or is professional services billed in units other than one. */
export function isHourlyLine(line: ValidationLine): boolean {
  if (NOT_HOURLY_WORDS.test(line.description)) return false;
  if (/\b(hours?|hrs?|hourly|heures?)\b/i.test(line.description)) return true;
  return HOURLY_WORDS.test(line.description) && line.quantity !== 1;
}

export function isFuelLine(line: ValidationLine): boolean {
  return FUEL_WORDS.test(line.description);
}

function statedPercent(description: string): string | null {
  const m = /(\d+(?:[.,]\d+)?)\s*%/.exec(description);
  return m ? m[1]!.replace(",", ".") : null;
}

export const contractRule: Rule = (input, ctx, d) => {
  const flags: Flag[] = [];
  const sel = selectContract(input, d, ctx.contracts);
  if (!sel || !input.invoiceDate) return flags;
  const c = sel.contract;
  const src = `contract ${c.id}`;

  if (sel.state === "expired") {
    flags.push(
      makeFlag(
        "CONTRACT_EXPIRED",
        `Invoice dated ${input.invoiceDate}, but contract ${c.id} (${c.description}) ended ${c.endDate}${c.status !== "active" ? ` and is ${c.status}` : ""} — confirm the rates still apply or renew the contract`,
        { field: "invoiceDate", actual: input.invoiceDate, expected: `${c.startDate}..${c.endDate}`, contractId: c.id, source: src },
      ),
    );
    return flags;
  }
  if (sel.state === "not_started") {
    flags.push(
      makeFlag("CONTRACT_NOT_STARTED", `Invoice dated ${input.invoiceDate}, before contract ${c.id} (${c.description}) starts on ${c.startDate}`, {
        field: "invoiceDate",
        actual: input.invoiceDate,
        expected: `${c.startDate}..${c.endDate}`,
        contractId: c.id,
        source: src,
      }),
    );
    return flags;
  }

  if (d.currency && d.currency !== c.currency) {
    flags.push(
      makeFlag("CONTRACT_CURRENCY_MISMATCH", `Invoice is in ${d.currency}, but contract ${c.id} is in ${c.currency}; amounts were not compared`, {
        field: "currency",
        actual: d.currency,
        expected: c.currency,
        contractId: c.id,
        source: src,
      }),
    );
    return flags;
  }

  const cur = c.currency;
  const tol = VALIDATION_CONFIG.centsTolerancePerLine;
  const month = monthOf(input.invoiceDate);
  const monthPrior = d.vendorPrior.filter(
    (p) => monthOf(p.invoiceDate) === month && (p.contractId === c.id || (p.contractId === null && p.vendorId === c.vendorId)),
  );

  // ---- fixed monthly fee ---------------------------------------------------------------------
  if (c.monthlyFeeCents !== null && !d.isCredit) {
    const fee = c.monthlyFeeCents;
    const base = input.lines.find((l) => Math.abs(l.amountCents - fee) <= tol);
    if (base) {
      const extras = input.lines.filter((l) => l !== base && l.amountCents !== 0);
      const extra = extras.reduce((s, l) => s + l.amountCents, 0);
      if (extra !== 0) {
        flags.push(
          makeFlag(
            "CONTRACT_USAGE_OVERAGE",
            `${formatMoney(extra, cur)} billed on top of the ${formatMoney(fee, cur)} fixed monthly fee (contract ${c.id}): line${extras.length > 1 ? "s" : ""} ${extras.map((l) => l.lineNo).join(", ")}`,
            { field: "lines", lineNo: extras[0]!.lineNo, actualCents: extra, contractId: c.id, source: src },
          ),
        );
      }
    } else if (d.subtotalCents !== null && Math.abs(d.subtotalCents - fee) > tol) {
      const diff = d.subtotalCents - fee;
      flags.push(
        makeFlag(
          "CONTRACT_FIXED_FEE_MISMATCH",
          `Billed ${formatMoney(d.subtotalCents, cur)}, but contract ${c.id} fixes the monthly fee at ${formatMoney(fee, cur)} (${diff > 0 ? "+" : ""}${percentForDisplay(diff, fee, 1)})`,
          { field: "subtotalCents", expectedCents: fee, actualCents: d.subtotalCents, contractId: c.id, source: src },
        ),
      );
    }

    const already = monthPrior.filter((p) => !p.isCreditNote).sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate));
    if (already.length > 0) {
      const first = already[0]!;
      flags.push(
        makeFlag(
          "CONTRACT_FIXED_FEE_BILLED_TWICE",
          `Contract ${c.id} is a fixed monthly fee and ${monthLabel(month)} was already billed on ${already.map((p) => `${p.invoiceNumber} (${p.invoiceDate}, ${formatMoney(p.subtotalCents, p.currency)})`).join(", ")}`,
          { field: "invoiceDate", actual: input.invoiceDate, month, alreadyBilled: already.map((p) => p.invoiceId), contractId: c.id, source: src },
          { relatedInvoiceId: first.invoiceId },
        ),
      );
    }
  }

  // ---- hourly rate cap -----------------------------------------------------------------------
  if (c.hourlyRateCapCents !== null && !d.isCredit) {
    for (const line of input.lines) {
      if (!isHourlyLine(line) || line.unitPriceCents <= c.hourlyRateCapCents) continue;
      const over = mulQty(line.quantity, line.unitPriceCents - c.hourlyRateCapCents);
      flags.push(
        makeFlag(
          "CONTRACT_RATE_CAP_EXCEEDED",
          `Line ${line.lineNo}: ${line.quantity} h at ${formatMoney(line.unitPriceCents, cur)}/h exceeds the contract ${c.id} cap of ${formatMoney(c.hourlyRateCapCents, cur)}/h (${formatMoney(over, cur)} over)`,
          { field: "lines.unitPriceCents", lineNo: line.lineNo, expectedCents: c.hourlyRateCapCents, actualCents: line.unitPriceCents, overByCents: over, contractId: c.id, source: src },
        ),
      );
    }
  }

  // ---- fuel surcharge cap --------------------------------------------------------------------
  if (c.fuelSurchargeCapPct !== null && !d.isCredit) {
    const fuel = input.lines.filter(isFuelLine);
    const freight = input.lines.filter((l) => !isFuelLine(l)).reduce((s, l) => s + l.amountCents, 0);
    for (const line of fuel) {
      const stated = statedPercent(line.description);
      const statedOver = stated !== null && compareDecimal(stated, c.fuelSurchargeCapPct) > 0;
      const allowed = freight > 0 ? mulPercent(freight, c.fuelSurchargeCapPct) : 0;
      const tolerance = tol * Math.max(1, input.lines.length - fuel.length);
      const computedOver = freight > 0 && line.amountCents > allowed + tolerance && comparePercent(line.amountCents, freight, c.fuelSurchargeCapPct) > 0;
      if (!statedOver && !computedOver) continue;
      const over = Math.max(0, line.amountCents - allowed);
      flags.push(
        makeFlag(
          "CONTRACT_FUEL_SURCHARGE_CAP",
          `Fuel surcharge ${stated !== null ? `${stated}% ` : ""}(line ${line.lineNo}: ${formatMoney(line.amountCents, cur)} on ${formatMoney(freight, cur)} of other charges = ${freight > 0 ? percentForDisplay(line.amountCents, freight) : "n/a"}) exceeds the contract ${c.id} cap of ${c.fuelSurchargeCapPct}%; ${formatMoney(over, cur)} over the cap`,
          {
            field: "lines.amountCents",
            lineNo: line.lineNo,
            expected: `${c.fuelSurchargeCapPct}%`,
            actual: stated !== null ? `${stated}%` : percentForDisplay(line.amountCents, freight),
            expectedCents: allowed,
            actualCents: line.amountCents,
            overByCents: over,
            contractId: c.id,
            source: src,
          },
        ),
      );
    }
  }

  // ---- monthly not-to-exceed -----------------------------------------------------------------
  if (c.notToExceedMonthlyCents !== null && d.subtotalCents !== null) {
    const before = monthPrior.filter((p) => p.currency === c.currency).reduce((s, p) => s + p.subtotalCents, 0);
    const after = before + d.subtotalCents;
    if (d.subtotalCents > 0 && after > c.notToExceedMonthlyCents) {
      flags.push(
        makeFlag(
          "CONTRACT_NTE_EXCEEDED",
          `${monthLabel(month)} spend under contract ${c.id} would reach ${formatMoney(after, cur)} with this invoice (${formatMoney(before, cur)} before it), above the ${formatMoney(c.notToExceedMonthlyCents, cur)} monthly not-to-exceed`,
          { field: "subtotalCents", month, expectedCents: c.notToExceedMonthlyCents, actualCents: after, priorMonthCents: before, contractId: c.id, source: src },
        ),
      );
    }
  }

  return flags;
};

function compareDecimal(a: string, b: string): number {
  const x = toRatio(a);
  const y = toRatio(b);
  const l = x.num * y.den;
  const r = y.num * x.den;
  return l > r ? 1 : l < r ? -1 : 0;
}

