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
  const [, month, day] = isoDate.slice(0, 10).split("-").map(Number);
  return `${MONTHS[month - 1]} ${day}`;
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
