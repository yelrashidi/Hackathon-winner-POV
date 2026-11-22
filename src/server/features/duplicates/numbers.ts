import { DUPLICATE_CONFIG } from "./config";

/**
 * Invoice-number comparison. Vendors and scans reformat the same number: "ST-4471" / "ST 4471" /
 * "st4471", "000604" / "604", and suffix a re-issue: "000903-A", "1655-A".
 */

/** Upper case, letters and digits only, leading zeros dropped from every digit run. "INV-02990" → "INV2990". */
export function canonicalNumber(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/\d+/g, (run) => run.replace(/^0+(?=\d)/, ""));
}

/** The digits of the canonical number, joined: "FA-001655" → "1655", "1655-A" → "1655". */
export function digitCore(s: string | null | undefined): string {
  return canonicalNumber(s).replace(/\D/g, "");
}

export type NumberRelation = "same" | "variant" | "different";

/**
 * same     equal once canonical ("ST-4471" = "st 4471", "000604" = "604")
 * variant  one is the other plus a short prefix/suffix ("903" vs "903A"), or the digit cores are
 *          equal ("FA1655" vs "1655A"). A variant alone is weak — sequential numbers like
 *          INV-01536 / INV-01537 differ by one digit but are never a variant — so the caller
 *          also needs the same amount or date before calling it a duplicate.
 */
export function compareNumbers(a: string | null | undefined, b: string | null | undefined): NumberRelation {
  const x = canonicalNumber(a);
  const y = canonicalNumber(b);
  if (!x || !y) return "different";
  if (x === y) return "same";

  const { variantMinChars, variantMaxExtraChars } = DUPLICATE_CONFIG;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length >= variantMinChars && long.length - short.length <= variantMaxExtraChars && (long.startsWith(short) || long.endsWith(short))) {
    return "variant";
  }
  const dx = digitCore(a);
  const dy = digitCore(b);
  if (dx.length >= variantMinChars && dx === dy) return "variant";
  return "different";
}
