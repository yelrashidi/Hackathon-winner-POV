/**
 * Everything payments needs from other features, one adapter each, all in this file.
 * Payment logic calls only these functions, never fake-data/ directly. Today they read the
 * in-memory fake data; step 11 swaps each one for the teammate's real code.
 * What each assumes, and whose it is: docs/payment-assumptions.md.
 */

import type { ApprovalPolicy } from "@/contracts/approvals";
import type { Flag } from "@/contracts/flag";
import type { DirectoryUser } from "@/server/features/approvals";
import { getState } from "./fake-data/store";
import type { ApprovalFacts, AuditEvent, BankAccountVersion, FlagRec, InvoiceRec, InvoiceStatus, PaymentRec, VendorRec } from "./types";

// TEMP: foundation (users table) — A2
export function getUser(userId: string): DirectoryUser | undefined {
  return getState().users.get(userId);
}

export function listUsers(): DirectoryUser[] {
  return [...getState().users.values()];
}

// TEMP: vendors (feature 9) — A6
export function getVendor(vendorId: string): VendorRec | undefined {
  return getState().vendors.get(vendorId);
}

// TEMP: foundation (invoices table) — A4
export function getInvoice(invoiceId: string): InvoiceRec | undefined {
  return getState().invoices.get(invoiceId);
}

export function listInvoices(): InvoiceRec[] {
  return [...getState().invoices.values()];
}

// TEMP: approvals (Youssef) — A1, A3b. Real version: approversOf(...await getApprovalPlans(id))
// and (await getCurrentApprovalPlan(id, { invoiceVersion })).basis. Today: approvals.csv history.
export function getApprovalFacts(invoiceId: string): ApprovalFacts | undefined {
  return getState().approvals.get(invoiceId);
}

// Real parser (Youssef's policiesFromCsv); TEMP: db for where the rows come from — A3
export function getReleasePolicies(): ApprovalPolicy[] {
  return getState().policies.filter((p) => p.active && p.ruleType === "payment_release");
}

// TEMP: validation (Andrew) + duplicates (no owner) — A5. Nobody stores invoice flags yet.
export function getOpenInvoiceFlags(invoiceId: string): Flag[] {
  return (getState().invoiceFlags.get(invoiceId) ?? []).filter((f) => f.status === "open");
}

// TEMP: vendors (feature 9) — A6, R5: payments holds the minimum bank-change data itself.
export function listBankAccounts(vendorId: string): BankAccountVersion[] {
  return getState().bankAccounts.filter((a) => a.vendorId === vendorId).sort((a, b) => a.version - b.version);
}

export function addBankAccount(account: BankAccountVersion): void {
  getState().bankAccounts.push(account);
}

// TEMP: core/audit (feature 8) — A9. Append-only.
export function emitAudit(event: Omit<AuditEvent, "id">): AuditEvent {
  const state = getState();
  const row = { id: `AUD-${String(++state.seq).padStart(5, "0")}`, ...event };
  state.audit.push(row);
  return row;
}

export function listAudit(): readonly AuditEvent[] {
  return getState().audit;
}

// TEMP: core/fire (foundation) — A7. The transitions payments fires, from brim-ap-diagrams.md.
const INVOICE_TRANSITIONS: Record<string, { from: InvoiceStatus; to: InvoiceStatus }> = {
  schedule: { from: "Approved", to: "PaymentScheduled" },
  paymentSettled: { from: "PaymentScheduled", to: "Paid" },
  paymentFailed: { from: "PaymentScheduled", to: "Approved" },
  paymentCancelled: { from: "PaymentScheduled", to: "Approved" },
};

export type InvoiceEvent = keyof typeof INVOICE_TRANSITIONS;

export function fireInvoiceEvent(invoiceId: string, event: InvoiceEvent, actorId: string, now: Date): void {
  const invoice = getInvoice(invoiceId);
  const t = INVOICE_TRANSITIONS[event];
  if (!invoice || invoice.status !== t.from) {
    throw new Error(`Illegal invoice transition: ${event} on ${invoiceId} in status ${invoice?.status ?? "missing"}`);
  }
  const before = invoice.status;
  invoice.status = t.to;
  emitAudit({
    occurredAt: now.toISOString(), actorId, onBehalfOf: null, action: `invoice.${event}`,
    entityType: "invoice", entityId: invoiceId, invoiceId, before: { status: before }, after: { status: t.to }, reason: null,
  });
}

// TEMP: db — payments' own tables (payments, payment_flags) until the schema lands.
export function paymentRows(): PaymentRec[] {
  return getState().payments;
}

export function flagRows(): FlagRec[] {
  return getState().flags;
}

/** Ids for new records (TEMP: db sequences). */
export function nextId(prefix: string): string {
  const state = getState();
  return `${prefix}-${String(++state.seq).padStart(5, "0")}`;
}
