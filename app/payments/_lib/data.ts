import "server-only";

// The one place the dashboard reads payment data. Pages call getPayments(); nothing else
// imports the sample file. TEMP: reads sample data shaped like docs/payment-data.md; when we merge
// Katie this calls listPayments() / getPaymentDetail() from "@/server/features/payments".

import { SAMPLE_FLAGS, SAMPLE_INVOICES, SAMPLE_PAYMENTS } from "./sample-data";
import type { InvoiceRecord, PaymentFlag, PaymentRecord, PaymentRow, PaymentsView, Urgency } from "./types";

export type { PaymentRow, PaymentsView } from "./types";

export async function getPayments(): Promise<PaymentsView> {
  return buildView(SAMPLE_INVOICES, SAMPLE_PAYMENTS, SAMPLE_FLAGS);
}

/** An invoice the dashboard knows about (paid, scheduled or approved), or null. */
export async function getInvoice(invoiceId: string): Promise<InvoiceRecord | null> {
  return SAMPLE_INVOICES.find((i) => i.invoiceId === invoiceId) ?? null;
}

/** One invoice's payment with all its attempts, or null if the invoice has no payment. */
export async function getPaymentRow(invoiceId: string): Promise<PaymentRow | null> {
  const { payments } = await getPayments();
  return payments.find((p) => p.invoice.invoiceId === invoiceId) ?? null;
}

export const URGENCY_ORDER: Urgency[] = ["critical", "high", "low"];

export function isOpen(flag: PaymentFlag): boolean {
  return flag.clearedAt === null;
}

/** Open flags, most urgent first. */
export function openFlags(row: PaymentRow): PaymentFlag[] {
  return row.flags.filter(isOpen).sort((a, b) => URGENCY_ORDER.indexOf(a.urgency) - URGENCY_ORDER.indexOf(b.urgency));
}

/** Latest attempt failed or is on hold, or an open flag applies to it. */
export function needsAttention(row: PaymentRow): boolean {
  return row.current.status === "failed" || row.current.status === "on_hold" || openFlags(row).length > 0;
}

/** Open flags by urgency, each flag counted once even when it applies to several payments. */
export function openFlagCounts(rows: PaymentRow[]): Record<Urgency, number> {
  const unique = new Map(rows.flatMap((r) => r.flags.filter(isOpen)).map((f) => [f.flagId, f]));
  const counts: Record<Urgency, number> = { critical: 0, high: 0, low: 0 };
  for (const f of unique.values()) counts[f.urgency]++;
  return counts;
}

function buildView(invoices: InvoiceRecord[], payments: PaymentRecord[], flags: PaymentFlag[]): PaymentsView {
  // A flag applies to its own payment, and (supplier scope) to every payment to that vendor.
  const flagsFor = (p: PaymentRecord, vendorId: string) =>
    flags.filter((f) => (f.scope === "payment" ? f.paymentId === p.paymentId : f.vendorId === vendorId));
  const newestFirst = (a: PaymentFlag, b: PaymentFlag) => b.createdAt.localeCompare(a.createdAt);

  const attemptsByInvoice = new Map<string, PaymentRecord[]>();
  for (const p of payments) {
    const list = attemptsByInvoice.get(p.invoiceId) ?? [];
    list.push(p);
    attemptsByInvoice.set(p.invoiceId, list);
  }

  const rows: PaymentRow[] = [];
  const awaitingPayment: InvoiceRecord[] = [];
  for (const invoice of invoices) {
    const attempts = (attemptsByInvoice.get(invoice.invoiceId) ?? [])
      .sort((a, b) => a.attemptNo - b.attemptNo)
      .map((a) => ({ ...a, flags: flagsFor(a, invoice.vendorId).sort(newestFirst) }));
    if (attempts.length === 0) {
      if (invoice.status === "Approved") awaitingPayment.push(invoice);
      continue;
    }
    const rowFlags = [...new Map(attempts.flatMap((a) => a.flags).map((f) => [f.flagId, f])).values()].sort(newestFirst);
    const current = attempts.at(-1);
    if (!current) continue; // unreachable: empty attempts handled above
    rows.push({ invoice, current, attempts, flags: rowFlags });
  }

  // Newest scheduled date first.
  rows.sort((a, b) => b.current.scheduledDate.localeCompare(a.current.scheduledDate));
  awaitingPayment.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return { payments: rows, awaitingPayment };
}
