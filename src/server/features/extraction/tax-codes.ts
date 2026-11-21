import { readFileSync } from "node:fs";
import path from "node:path";

/** One row of the tax-code table. Rates come from the table, never from code (money-and-tax.md). */
export interface TaxCodeRef {
  code: string;
  description: string;
  /** Decimal rate as a string, e.g. "0.09975". */
  rate: string;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** From the dataset until the tax_codes table exists (step 3 swaps this for a DB query). */
export function taxCodesFromCsv(
  file = path.resolve("brim_ap_dataset/brim_ap_dataset/data/tax_codes.csv"),
): TaxCodeRef[] {
  const [header, ...rows] = readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim());
  const cols = splitCsvLine(header!);
  const idx = (name: string) => cols.indexOf(name);
  return rows.map((r) => {
    const c = splitCsvLine(r);
    return { code: c[idx("code")]!, description: c[idx("description")]!, rate: c[idx("rate")]! };
  });
}
