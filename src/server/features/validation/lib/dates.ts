/** ISO-date helpers (YYYY-MM-DD). All UTC, so no timezone drift. */

/** True only for a real calendar day: "2026-02-28" yes, "2026-02-30" and "2026-13-01" no. */
export function isRealDate(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

function toUtcDay(iso: string): number {
  // Date.UTC silently rolls 2026-02-30 over to March 2; refuse instead.
  if (!isRealDate(iso)) throw new Error(`Not a real calendar date: "${iso}"`);
  const [y, mo, d] = iso.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, mo - 1, d) / 86_400_000;
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function daysBetween(from: string, to: string): number {
  return toUtcDay(to) - toUtcDay(from);
}

export function addDays(iso: string, days: number): string {
  const d = new Date((toUtcDay(iso) + days) * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** "2026-10" */
export function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

/** "2026-10" → "October 2026" */
export function monthLabel(month: string): string {
  const names = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const [y, m] = month.split("-");
  return `${names[Number(m) - 1] ?? m} ${y}`;
}
