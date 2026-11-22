// Display formatting for the whole app. Amounts stay integer cents everywhere; these only turn them
// into text, without floats (docs/rules/money-and-tax.md). TEMP: until core/money exists.

export { parseMoneyToCents, todayIso, addDays } from "../payments/_lib/format";

/** 245719 → "$2,457.19"; negative (credit notes) → "−$2,457.19". */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "−" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-CA")}.${String(abs % 100).padStart(2, "0")}`;
}

/** Cents → the plain number a form field shows ("2457.19"), no thousands separators. */
export function centsToInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-24" → "Nov 24, 2026". Parsed by hand so the time zone can't shift the day. */
export function formatDay(isoDate: string | null): string {
  if (!isoDate) return "—";
  const [y, m = 0, d = 0] = isoDate.slice(0, 10).split("-").map(Number);
  const name = MONTHS[m - 1];
  return name ? `${name} ${d}, ${y}` : isoDate;
}

/** A timestamp in Toronto time: "Nov 21, 2026, 14:05". */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

/** "3 days ago" style, from a timestamp. */
export function ago(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return "";
  const minutes = Math.round((now.getTime() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0] ?? "")
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));
