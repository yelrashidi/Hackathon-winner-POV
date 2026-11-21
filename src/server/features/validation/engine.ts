import type { Flag, FlagSeverity } from "@/contracts/flag";
import { ValidationInput, type ValidationInputDraft } from "@/contracts/validation";
import { FLAG_CODES, type RuleGroup } from "./codes";
import type { ValidationContext } from "./context";
import { derive, setAsideInvalidDates, type Derived } from "./derive";
import { makeFlag } from "./flag";
import { arithmeticRule } from "./rules/arithmetic";
import { bankRule } from "./rules/bank";
import { completenessRule } from "./rules/completeness";
import { contractRule, selectContract } from "./rules/contract";
import { datesRule } from "./rules/dates";
import { fxRule } from "./rules/fx";
import { poRule } from "./rules/po";
import { splitRule } from "./rules/split";
import { taxRule } from "./rules/tax";
import type { Rule } from "./rules/types";
import { vendorRule } from "./rules/vendor";
import type { VendorMatch } from "./vendor-match";

/** Every rule, in the order they run. Completeness first; the others skip what is missing. */
export const RULES: readonly { group: RuleGroup; run: Rule }[] = [
  { group: "completeness", run: completenessRule },
  { group: "arithmetic", run: arithmeticRule },
  { group: "tax", run: taxRule },
  { group: "vendor", run: vendorRule },
  { group: "bank", run: bankRule },
  { group: "po", run: poRule },
  { group: "contract", run: contractRule },
  { group: "dates", run: datesRule },
  { group: "fx", run: fxRule },
  { group: "split", run: splitRule },
];

export interface ValidationResult {
  invoiceId: string;
  /** Sorted: block, then warn, then info; within a severity, by rule order. */
  flags: Flag[];
  /** What the rest of the pipeline needs from the analysis (approvals: vendorId, totalCadCents). */
  vendorId: string | null;
  vendorMatch: VendorMatch;
  deliveryProvince: string | null;
  contractId: string | null;
  totalCadCents: number | null;
  /** Rate used for USD (null for CAD). */
  fxRate: string | null;
  blocking: boolean;
}

const SEVERITY_ORDER: Record<FlagSeverity, number> = { block: 0, warn: 1, info: 2 };

/**
 * Runs every rule on one invoice. Pure: no I/O, no clock. A rule that throws becomes a
 * VALIDATION_RULE_ERROR flag (the invoice still gets every other check), never a crash.
 * Throws only if `rawInput` does not satisfy the ValidationInput contract.
 */
export function validateInvoice(rawInput: ValidationInputDraft | ValidationInput, ctx: ValidationContext): ValidationResult {
  const parsed = ValidationInput.parse(rawInput);
  const { input, invalidDates } = setAsideInvalidDates(parsed, ctx.today);
  const d: Derived = derive(input, ctx, invalidDates);

  const flags: Flag[] = [];
  RULES.forEach(({ group, run }) => {
    try {
      flags.push(...run(input, ctx, d));
    } catch (err) {
      flags.push(
        makeFlag("VALIDATION_RULE_ERROR", `The ${group} check could not run on this invoice (${err instanceof Error ? err.message : String(err)}) — review it by hand`, {
          field: group,
        }),
      );
    }
  });

  const ruleIndex = new Map(RULES.map((r, i) => [r.group as string, i]));
  const sorted = flags
    .map((f, i) => ({ f, i }))
    .sort((a, b) => {
      const s = SEVERITY_ORDER[a.f.severity] - SEVERITY_ORDER[b.f.severity];
      if (s !== 0) return s;
      const ra = ruleIndex.get(FLAG_CODES[a.f.code as keyof typeof FLAG_CODES]?.rule ?? "") ?? 99;
      const rb = ruleIndex.get(FLAG_CODES[b.f.code as keyof typeof FLAG_CODES]?.rule ?? "") ?? 99;
      return ra - rb || a.i - b.i;
    })
    .map((x) => x.f);

  const contract = selectContract(input, d, ctx.contracts);
  return {
    invoiceId: input.invoiceId,
    flags: sorted,
    vendorId: d.vendor?.id ?? null,
    vendorMatch: d.vendorMatch,
    deliveryProvince: d.province.province,
    contractId: contract?.state === "in_force" ? contract.contract.id : null,
    totalCadCents: d.totalCadCents,
    fxRate: d.fxRate?.usdToCad ?? null,
    blocking: hasBlocking(sorted),
  };
}

/** The submit guard: any OPEN block flag keeps the invoice in review. */
export function hasBlocking(flags: readonly Flag[]): boolean {
  return flags.some((f) => f.status === "open" && f.severity === "block");
}
