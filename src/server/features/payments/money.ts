// TEMP: core/money — cents formatting and the FX re-check, until the foundation's helpers exist.

export function formatMoney(cents: number, currency = "CAD"): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-CA");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")} ${currency}`;
}

/**
 * Does total × rate equal the stored CAD total, within 1 cent? Decimal string math, no floats.
 * BUG-Youssef-02: an unconverted USD total under-approves, so anything that limits on CAD re-checks.
 */
export function cadMatches(totalCents: number, rate: string, totalCadCents: number): boolean {
  const m = rate.match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) return false;
  const frac = m[2] ?? "";
  const ONE = BigInt(1);
  const TWO = BigInt(2);
  const scale = BigInt(10) ** BigInt(frac.length);
  const rateScaled = BigInt(m[1] + frac);
  const product = BigInt(totalCents) * rateScaled;
  // round half up to whole cents
  const rounded = (product * TWO + scale) / (scale * TWO);
  const diff = rounded - BigInt(totalCadCents);
  return diff >= -ONE && diff <= ONE;
}
