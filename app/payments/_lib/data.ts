import "server-only";

// The one place the dashboard reads payment data: the real payments service, for the signed-in
// person (it filters by role on the server). Shapes come from @/contracts/payment.

import type { FlagUrgency, InvoiceRecord, PaymentFlag, PaymentRow, PaymentsView } from "@/contracts/payment";
import { getPaymentDetail, listPayments } from "@/server/features/payments";
import { getCurrentUser } from "@/server/session/current-user";

export type { PaymentRow, PaymentsView } from "@/contracts/payment";

async function viewerId(): Promise<string | null> {
  return (await getCurrentUser())?.id ?? null;
}

export async function getPayments(): Promise<PaymentsView> {
  const view = await listPayments(await viewerId());
  // Dashboard order: newest scheduled date first.
  return { ...view, payments: [...view.payments].sort((a, b) => b.current.scheduledDate.localeCompare(a.current.scheduledDate)) };
}

/** An invoice the signed-in person may see (with a payment, or approved and waiting), or null. */
export async function getInvoice(invoiceId: string): Promise<InvoiceRecord | null> {
  const view = await listPayments(await viewerId());
  return (
    view.payments.find((p) => p.invoice.invoiceId === invoiceId)?.invoice ??
    view.awaitingPayment.find((i) => i.invoiceId === invoiceId) ??
    null
  );
}

/** One invoice's payment with all its attempts, or null if the invoice has no payment. */
export async function getPaymentRow(invoiceId: string): Promise<PaymentRow | null> {
  return getPaymentDetail(await viewerId(), invoiceId);
}

export const URGENCY_ORDER: FlagUrgency[] = ["critical", "high", "low"];

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
export function openFlagCounts(rows: PaymentRow[]): Record<FlagUrgency, number> {
  const unique = new Map(rows.flatMap((r) => r.flags.filter(isOpen)).map((f) => [f.flagId, f]));
  const counts: Record<FlagUrgency, number> = { critical: 0, high: 0, low: 0 };
  for (const f of unique.values()) counts[f.urgency]++;
  return counts;
}

/** A failed attempt can be retried unless it's a fraud hold the Controller hasn't cleared yet. */
export function canRetry(row: PaymentRow): boolean {
  if (row.current.failure?.retryRule !== "ESCALATE") return true;
  return !openFlags(row).some((f) => f.urgency === "critical");
}
