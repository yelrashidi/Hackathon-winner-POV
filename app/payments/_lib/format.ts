// TEMP: local formatters until the shared money helper (src/server/core/money) exists.
// Amounts stay integer cents; this only turns them into display strings, without floats.

import type { Currency } from "./types";

/** 245719 → "$2,457.19". Negative amounts (credit notes) → "−$2,457.19". */
export function formatMoney(cents: number): string {
  const sign = cents < 0 ? "−" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-CA");
  const rest = String(abs % 100).padStart(2, "0");
  return `${sign}$${dollars}.${rest}`;
}

export function formatMoneyWithCode(cents: number, currency: Currency): string {
  return `${formatMoney(cents)} ${currency}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-24" → "Nov 24". Parsed by hand so the time zone can't shift the day. */
export function formatDate(isoDate: string | null): string {
  if (!isoDate) return "—";
  const [, month = 0, day = 0] = isoDate.slice(0, 10).split("-").map(Number);
  const name = MONTHS[month - 1];
  return name ? `${name} ${day}` : isoDate;
}

/** Today as YYYY-MM-DD in Toronto time (Harborline's head office). */
export function todayIso(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());
}

/** YYYY-MM-DD plus n days. */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Typed amount → integer cents, or null if it isn't a valid amount. Accepts "2,457.19",
 * "2457.19", "$2,457.19" and the French "2 457,19 $". Never goes through a float.
 */
export function parseMoneyToCents(input: string): number | null {
  let s = input.replace(/[\s $]|CAD|USD/gi, "");
  if (!s) return null;
  const negative = /^[-−]/.test(s);
  s = s.replace(/^[-−]/, "");
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  let decimalSep = "";
  if (lastComma > -1 && lastDot > -1) decimalSep = lastComma > lastDot ? "," : ".";
  else if (lastComma > -1 && /,\d{1,2}$/.test(s)) decimalSep = ",";
  else if (lastDot > -1 && /\.\d{1,2}$/.test(s)) decimalSep = ".";
  let whole = s;
  let fraction = "";
  if (decimalSep) {
    const i = s.lastIndexOf(decimalSep);
    whole = s.slice(0, i);
    fraction = s.slice(i + 1);
  }
  whole = whole.replace(/[.,]/g, "");
  if (!/^\d*$/.test(whole) || !/^\d{0,2}$/.test(fraction) || (whole === "" && fraction === "")) return null;
  const cents = Number(whole || "0") * 100 + Number(fraction.padEnd(2, "0"));
  return negative ? -cents : cents;
}
