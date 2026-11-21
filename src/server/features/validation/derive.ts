import type { ValidationInput } from "@/contracts/validation";
import { VALIDATION_CONFIG } from "./config";
import type { FxRate, PriorInvoice, ValidationContext, VendorRef } from "./context";
import { isRealDate } from "./lib/dates";
import { rateFor, toCadCents } from "./lib/fx";
import { normalizeInvoiceNumber } from "./lib/text";
import { resolveDeliveryProvince, type ProvinceResolution } from "./province";
import { matchVendor, type VendorMatch } from "./vendor-match";

/**
 * Facts computed once per invoice and shared by every rule, so two rules never disagree about
 * which vendor this is, what province it was delivered to, or what it is worth in CAD.
 */
export interface Derived {
  vendorMatch: VendorMatch;
  vendor: VendorRef | null;
  province: ProvinceResolution;
  /** Upper-cased currency code, or null. */
  currency: string | null;
  /** The USD→CAD rate used (null for CAD or when missing). */
  fxRate: FxRate | null;
  /** Printed subtotal, else the sum of the lines; null when neither exists. */
  subtotalCents: number | null;
  subtotalCadCents: number | null;
  totalCadCents: number | null;
  /** Marked as a credit note, or a negative total. */
  isCredit: boolean;
  /**
   * This vendor's other invoices on record that count: not rejected/voided, not this invoice,
   * and not the same (or a near-same) invoice number — that is a duplicate, feature 5's call,
   * and counting it would double every sum below.
   */
  vendorPrior: PriorInvoice[];
  /** Dates that were not real calendar days; already removed from the input the rules see. */
  invalidDates: InvalidDate[];
}

export interface InvalidDate {
  field: "invoiceDate" | "dueDate" | "receivedDate";
  value: string;
  /** What the rules use instead: null, or today's date for the received date. */
  replacedWith: string | null;
}

/**
 * Takes impossible calendar dates (2026-02-30) out of the input before any rule runs, so no
 * rule computes an age or a term from a date that rolled over to another month. The received
 * date is always needed, so it falls back to `today`; the others become missing.
 */
export function setAsideInvalidDates(input: ValidationInput, today: string): { input: ValidationInput; invalidDates: InvalidDate[] } {
  const invalidDates: InvalidDate[] = [];
  const out = { ...input };
  if (input.invoiceDate && !isRealDate(input.invoiceDate)) {
    invalidDates.push({ field: "invoiceDate", value: input.invoiceDate, replacedWith: null });
    out.invoiceDate = null;
  }
  if (input.dueDate && !isRealDate(input.dueDate)) {
    invalidDates.push({ field: "dueDate", value: input.dueDate, replacedWith: null });
    out.dueDate = null;
  }
  if (!isRealDate(input.receivedDate)) {
    invalidDates.push({ field: "receivedDate", value: input.receivedDate, replacedWith: today });
    out.receivedDate = today;
  }
  return { input: out, invalidDates };
}

const IGNORED_STATUSES = new Set(["rejected", "voided"]);

export function countsAsActive(p: PriorInvoice): boolean {
  return !IGNORED_STATUSES.has(p.status.trim().toLowerCase());
}

/**
 * Same invoice number after normalisation, or one is the other plus a short suffix/prefix
 * ("000903" vs "000903-A"). Used only to keep duplicates out of sums; never raises a flag.
 */
export function sameInvoiceNumber(a: string, b: string): boolean {
  const x = normalizeInvoiceNumber(a);
  const y = normalizeInvoiceNumber(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 4 && long.length - short.length <= 2 && (long.startsWith(short) || long.endsWith(short));
}

export function derive(input: ValidationInput, ctx: ValidationContext, invalidDates: InvalidDate[] = []): Derived {
  const vendorMatch = matchVendor(input, ctx.vendors);
  const vendor = vendorMatch.vendor;
  const province = resolveDeliveryProvince(input, ctx.offices);
  const currency = input.currency ? input.currency.trim().toUpperCase() : null;

  const fxDate = input.invoiceDate ?? input.receivedDate;
  // fx_rates holds USD→CAD only; any other non-CAD currency has no rate (CURRENCY_UNSUPPORTED).
  const fxRate = currency === "USD" ? rateFor(fxDate, ctx.fxRates, VALIDATION_CONFIG.fxLookbackDays) : null;

  const lineSum = input.lines.length > 0 ? input.lines.reduce((s, l) => s + l.amountCents, 0) : null;
  const subtotalCents = input.subtotalCents ?? lineSum;
  const subtotalCadCents = subtotalCents !== null && currency ? toCadCents(subtotalCents, currency, fxRate) : null;
  const totalCadCents = input.totalCents !== null && currency ? toCadCents(input.totalCents, currency, fxRate) : null;

  const isCredit = input.documentType === "credit_note" || (input.totalCents !== null && input.totalCents < 0);

  const vendorPrior = vendor
    ? ctx.priorInvoices.filter(
        (p) =>
          p.vendorId === vendor.id &&
          p.invoiceId !== input.invoiceId &&
          countsAsActive(p) &&
          !(input.invoiceNumber && sameInvoiceNumber(p.invoiceNumber, input.invoiceNumber)),
      )
    : [];

  return { vendorMatch, vendor, province, currency, fxRate, subtotalCents, subtotalCadCents, totalCadCents, isCredit, vendorPrior, invalidDates };
}
