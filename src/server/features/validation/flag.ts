import type { Flag, FlagSeverity } from "@/contracts/flag";
import { FLAG_CODES, type FlagCode } from "./codes";

/**
 * Evidence every validation flag carries, so the UI can render "expected vs actual" without
 * knowing which rule raised it. `field` + `lineNo` also give the flag its identity across re-runs.
 */
export interface Evidence {
  /** Which input field the flag is about: "totalCents", "lines.amountCents", "taxes", "poNumber"… */
  field: string;
  lineNo?: number;
  expected?: unknown;
  actual?: unknown;
  expectedCents?: number;
  actualCents?: number;
  /** Where the expectation comes from: "tax_codes", "contract C018", "vendor master V001"… */
  source?: string;
  [key: string]: unknown;
}

export interface MakeFlagOptions {
  severity?: FlagSeverity;
  relatedInvoiceId?: string;
}

/** Builds a Flag with the code's default severity (overridable) and the rule group in evidence. */
export function makeFlag(code: FlagCode, message: string, evidence: Evidence, opts: MakeFlagOptions = {}): Flag {
  const info = FLAG_CODES[code];
  const flag: Flag = {
    code,
    severity: opts.severity ?? info.severity,
    message,
    evidence: { rule: info.rule, ...evidence },
    status: "open",
  };
  if (opts.relatedInvoiceId) flag.relatedInvoiceId = opts.relatedInvoiceId;
  return flag;
}

/** Identity of a flag across re-runs: code + field + line. */
export function flagKey(flag: Flag): string {
  const ev = flag.evidence as Partial<Evidence>;
  return [flag.code, ev.field ?? "", ev.lineNo ?? ""].join("|");
}
