import "server-only";

// The one place the dashboard reads payment data. Pages call getPayments(); nothing else
// imports the sample file. TEMP: reads sample data until docs/payment-data.md exists, then
// this function switches to the payment session's real source and the sample file goes.

import { SAMPLE_INVOICES, SAMPLE_PAYMENTS } from "./sample-data";
import type { InvoiceRecord, PaymentRecord } from "./types";

/** One invoice's payment: its latest attempt plus every attempt, oldest first. */
export type PaymentRow = {
  invoice: InvoiceRecord;
  current: PaymentRecord;
  attempts: PaymentRecord[];
};

export type PaymentsView = {
  payments: PaymentRow[];
  /** Approved invoices with no payment attempt yet. */
  awaitingPayment: InvoiceRecord[];
};

export async function getPayments(): Promise<PaymentsView> {
  return buildView(SAMPLE_INVOICES, SAMPLE_PAYMENTS);
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

/** Latest attempt failed, or payment is on hold. */
export function needsAttention(row: PaymentRow): boolean {
  return row.current.status === "failed" || row.current.status === "on_hold";
}

function buildView(invoices: InvoiceRecord[], payments: PaymentRecord[]): PaymentsView {
  const attemptsByInvoice = new Map<string, PaymentRecord[]>();
  for (const p of payments) {
    const list = attemptsByInvoice.get(p.invoiceId) ?? [];
    list.push(p);
    attemptsByInvoice.set(p.invoiceId, list);
  }

  const rows: PaymentRow[] = [];
  const awaitingPayment: InvoiceRecord[] = [];
  for (const invoice of invoices) {
    const attempts = (attemptsByInvoice.get(invoice.invoiceId) ?? []).sort(
      (a, b) => a.attemptNo - b.attemptNo,
    );
    if (attempts.length === 0) {
      if (invoice.status === "approved") awaitingPayment.push(invoice);
      continue;
    }
    rows.push({ invoice, current: attempts[attempts.length - 1], attempts });
  }

  // Newest scheduled date first.
  rows.sort((a, b) => b.current.scheduledDate.localeCompare(a.current.scheduledDate));
  awaitingPayment.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return { payments: rows, awaitingPayment };
}
