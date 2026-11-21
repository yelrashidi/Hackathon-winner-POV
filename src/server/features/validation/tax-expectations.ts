import type { TaxCodeRef } from "./context";
import { toRatio } from "./lib/money";

/**
 * Which tax codes the province of delivery requires (Canadian sales-tax law, as the dataset's
 * README states it). Only the CODES are listed here; every rate and whether a code applies to
 * goods only come from the `tax_codes` table, never from this file (money-and-tax.md).
 *
 * ON → HST · BC → GST + PST (goods only) · QC → GST + QST (on the pre-tax amount) ·
 * AB and the territories, MB, SK → GST (the table has no provincial code for MB/SK).
 * The HST provinces NB, NS, NL, PE are deliberately absent: the table has no 15% HST code, so
 * an invoice delivered there gets TAX_PROVINCE_UNKNOWN instead of a guessed rate.
 */
export const PROVINCE_TAX_CODES: Readonly<Record<string, readonly string[]>> = {
  ON: ["HST13"],
  BC: ["GST5", "PST7_BC"],
  QC: ["GST5", "QST9975"],
  AB: ["GST5"],
  MB: ["GST5"],
  SK: ["GST5"],
  YT: ["GST5"],
  NT: ["GST5"],
  NU: ["GST5"],
};

/** Which registration number a tax code needs on the invoice. Keyed by tax_codes.code. */
export type TaxFamily = "gst_hst" | "qst" | "pst" | "zero";
export const TAX_FAMILY: Readonly<Record<string, TaxFamily>> = {
  HST13: "gst_hst",
  GST5: "gst_hst",
  QST9975: "qst",
  PST7_BC: "pst",
  EXEMPT: "zero",
  FOREIGN: "zero",
};

export function familyOf(code: string): TaxFamily | undefined {
  return TAX_FAMILY[code];
}

/** "Ontario HST 13%" from "Ontario HST 13%", "Quebec QST 9.975%" from "Quebec QST 9.975% (on pre-tax amount)". */
export function shortTaxLabel(t: TaxCodeRef): string {
  const m = /^(.*?%)/.exec(t.description);
  return m ? m[1]! : t.code;
}

export function goodsOnly(t: TaxCodeRef): boolean {
  return t.appliesTo.trim().toLowerCase() === "goods";
}

/** A code with a zero rate (EXEMPT, FOREIGN) never expects an amount. */
export function isZeroRate(t: TaxCodeRef): boolean {
  return /^0*(\.0*)?$/.test(t.rate.trim());
}

/** Label keywords, English and French, → the family of tax they name. */
const LABEL_FAMILIES: readonly [RegExp, TaxFamily][] = [
  [/\b(QST|TVQ)\b/i, "qst"],
  [/\b(PST|TVP|RST)\b/i, "pst"],
  [/\b(GST|TPS|HST|TVH)\b/i, "gst_hst"],
];

/**
 * A safety net for a tax line extraction left unmapped (code null). Infers the code only when
 * BOTH the label names a tax family ("TVH", "TPS", "QST"…) AND the printed rate equals exactly
 * one tax_codes rate in that family: "TVH (13 %)" → HST13, "TPS (5 %)" → GST5. Anything less
 * certain stays unmapped (TAX_CODE_UNKNOWN) — never a guess.
 */
export function inferTaxCode(label: string, ratePct: number | null, taxCodes: readonly TaxCodeRef[]): TaxCodeRef | null {
  const family = LABEL_FAMILIES.find(([re]) => re.test(label))?.[1];
  if (!family) return null;
  let pct: string | null = ratePct !== null ? String(ratePct) : null;
  if (pct === null) {
    const m = /(\d+(?:[.,]\d+)?)\s*%/.exec(label);
    pct = m ? m[1]!.replace(",", ".") : null;
  }
  if (pct === null) return null;
  const p = toRatio(pct);
  const matches = taxCodes.filter((t) => {
    if (familyOf(t.code) !== family) return false;
    const r = toRatio(t.rate); // rate as a fraction; pct/100 == rate  ⇔  p.num·r.den == r.num·p.den·100
    return p.num * r.den === r.num * p.den * 100n;
  });
  return matches.length === 1 ? matches[0]! : null;
}
