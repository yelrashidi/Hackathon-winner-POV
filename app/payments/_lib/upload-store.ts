import "server-only";

// TEMP: confirmed uploads live in server memory until the database exists. Lost on restart.
// Each record carries the invoice in the shape of Andrew's ValidationInput
// (src/contracts/validation.ts on his branch), so validation can read it directly later.

import type { Person } from "./types";

export type UploadedInvoiceInput = {
  invoiceId: string;
  documentType: "invoice";
  vendor: { nameRaw: string; gstHstNumber: null; qstNumber: null; province: null; country: null };
  senderEmail: null; // uploads have no sender
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string | null;
  receivedDate: string; // upload date
  currency: string;
  poNumber: string | null;
  shipToProvince: string | null;
  lines: { lineNo: number; description: string; quantity: number; unitPriceCents: number; amountCents: number; lineType: null }[];
  taxes: { code: string; label: string; ratePct: null; amountCents: number }[];
  subtotalCents: number | null;
  totalCents: number;
  departmentId: string;
  requesterId: string;
  confidence: Record<string, number>;
};

export type UploadedInvoice = {
  invoiceId: string;
  status: "InReview";
  fileName: string;
  uploadedBy: Person;
  uploadedAt: string;
  input: UploadedInvoiceInput;
};

// Kept on globalThis so dev hot-reloads don't wipe it.
const store = globalThis as unknown as { __uploadedInvoices?: UploadedInvoice[] };
store.__uploadedInvoices ??= [];

/** UP-0001, UP-0002…: temporary until the database assigns IDs. */
export function nextUploadId(): string {
  return `UP-${String(store.__uploadedInvoices!.length + 1).padStart(4, "0")}`;
}

export function saveUploadedInvoice(invoice: UploadedInvoice): void {
  store.__uploadedInvoices!.push(invoice);
}
