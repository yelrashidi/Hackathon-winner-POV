/**
 * Integer-cents arithmetic for validation (docs/rules/money-and-tax.md).
 *
 * Money is always integer cents. Rates and quantities are decimals, so we multiply exactly
 * (BigInt over a power-of-ten denominator) and round ONCE, half away from zero: 0.5¢ → 1¢ and
 * −0.5¢ → −1¢, so a credit note rounds like the invoice it reverses.
 *
 * Validation-local until src/server/core/money.ts exists; then these delegate to it.
 */

export interface Ratio {
  num: bigint;
  den: bigint;
}

/** "0.09975" → 9975/100000, "12" → 12/1, "-1.5" → -15/10. Accepts numbers too. */
export function toRatio(value: string | number): Ratio {
  let s = typeof value === "number" ? numberToPlainString(value) : value.trim();
  if (!/^[-+]?\d*(\.\d+)?$/.test(s) || s === "" || s === "-" || s === "+") {
    throw new Error(`Not a decimal: "${value}"`);
  }
  let sign = 1n;
  if (s.startsWith("-")) {
    sign = -1n;
    s = s.slice(1);
  } else if (s.startsWith("+")) s = s.slice(1);
  const [intPart = "0", fracPart = ""] = s.split(".");
  const den = 10n ** BigInt(fracPart.length);
  const num = BigInt((intPart || "0") + fracPart) * sign;
  return { num, den };
}

function numberToPlainString(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`Not a finite number: ${n}`);
  const s = String(n);
  if (!/e/i.test(s)) return s;
  // 1e-7 style: expand without float noise beyond 12 decimals (quantities and rates never need more).
  return n.toFixed(12).replace(/\.?0+$/, "");
}

/** num / den rounded half away from zero. */
export function divRoundHalfAway(num: bigint, den: bigint): bigint {
  if (den === 0n) throw new Error("Division by zero");
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const negative = num < 0n;
  const abs = negative ? -num : num;
  const q = (abs * 2n + den) / (2n * den); // floor(abs/den + 1/2)
  return negative ? -q : q;
}

function toSafeNumber(v: bigint): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`Amount out of safe integer range: ${v}`);
  }
  return Number(v);
}

/** cents × rate, rounded once. mulRate(514500, "0.13") = 66885. */
export function mulRate(cents: number, rate: string | number): number {
  const r = toRatio(rate);
  return toSafeNumber(divRoundHalfAway(BigInt(cents) * r.num, r.den));
}

/** quantity × unit price, rounded once. mulQty(2.5, 41999) = 104998 (104997.5 → 104998). */
export function mulQty(quantity: number, unitCents: number): number {
  return mulRate(unitCents, quantity);
}

/** cents × percent / 100, rounded once. mulPercent(120000, "12") = 14400. */
export function mulPercent(cents: number, pct: string | number): number {
  const r = toRatio(pct);
  return toSafeNumber(divRoundHalfAway(BigInt(cents) * r.num, r.den * 100n));
}

/**
 * Compares part/whole (as a percent) with a percent cap, exactly.
 * Returns 1 if part/whole×100 > cap, 0 if equal, -1 if below. whole must be non-zero.
 */
export function comparePercent(partCents: number, wholeCents: number, capPct: string | number): -1 | 0 | 1 {
  const r = toRatio(capPct);
  // part/whole*100 ? num/den  ⇔  part*100*den ? num*whole   (whole > 0 after sign normalisation)
  let part = BigInt(partCents);
  let whole = BigInt(wholeCents);
  if (whole === 0n) throw new Error("comparePercent: whole is zero");
  if (whole < 0n) {
    part = -part;
    whole = -whole;
  }
  const left = part * 100n * r.den;
  const right = r.num * whole;
  return left > right ? 1 : left < right ? -1 : 0;
}

/** part/whole as a percent, for display only (never used in a comparison). */
export function percentForDisplay(partCents: number, wholeCents: number, digits = 2): string {
  if (wholeCents === 0) return "n/a";
  const bps = divRoundHalfAway(BigInt(partCents) * 10n ** BigInt(digits + 2), BigInt(wholeCents));
  return formatScaled(bps, digits) + "%";
}

function formatScaled(v: bigint, digits: number): string {
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const scale = 10n ** BigInt(digits);
  const int = abs / scale;
  const frac = (abs % scale).toString().padStart(digits, "0");
  return `${negative ? "-" : ""}${int}${digits > 0 ? "." + frac : ""}`;
}

/**
 * Parses a printed amount straight to cents, English or French:
 * "$1,234.56" → 123456 · "-$1,042.76" → -104276 · "1 014,18 $" → 101418 · "2 260,00 $" → 226000.
 */
export function parseMoneyToCents(text: string): number {
  let s = text.replace(/[\s  ]/g, "").replace(/\$|CAD|USD|US/gi, "");
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  }
  if (s.endsWith("-")) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  // Decimal separator = the last of "." or "," when followed by exactly 1–2 digits.
  const m = /^(.*?)[.,](\d{1,2})$/.exec(s);
  let intPart = s;
  let frac = "00";
  if (m) {
    intPart = m[1]!;
    frac = m[2]!.padEnd(2, "0");
  }
  intPart = intPart.replace(/[.,']/g, "");
  if (!/^\d+$/.test(intPart)) throw new Error(`Not an amount: "${text}"`);
  const cents = Number(intPart) * 100 + Number(frac);
  return negative ? -cents : cents;
}

/** 123456 → "$1,234.56"; non-CAD currencies get their code: "$1,950.00 USD". */
export function formatMoney(cents: number, currency: string | null = "CAD"): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const out = `${negative ? "-" : ""}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
  return currency && currency !== "CAD" ? `${out} ${currency}` : out;
}

/** "0.09975" → "9.975%", "0.13" → "13%". Display only. */
export function formatRateAsPercent(rate: string): string {
  const r = toRatio(rate);
  // rate × 100 exactly, trimmed.
  const scaled = divRoundHalfAway(r.num * 100n * 1000000n, r.den); // 6 decimals
  return formatScaled(scaled, 6).replace(/\.?0+$/, "") + "%";
}
