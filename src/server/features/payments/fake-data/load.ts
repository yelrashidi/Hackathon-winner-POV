// TEMP: db — builds payments' starting state from the delivered dataset until the seed exists.
// Only open work is loaded (approved, or scheduled by EFT); the paid history is not.

import type { Currency, PaymentMethod } from "@/contracts/payment";
import { policiesFromCsv, type DirectoryUser, type PolicyCsvRow, type UserRole } from "@/server/features/approvals";
import type { BankAccountVersion, InvoiceRec, PaymentRec, PaymentsState, VendorRec } from "../types";
import { dollarsToCents, readCsv } from "./csv";

const OPEN_INVOICE_STATUS: Record<string, string> = { approved: "Approved", scheduled: "PaymentScheduled" };

export function loadDatasetState(): PaymentsState {
  const users = new Map<string, DirectoryUser>();
  for (const u of readCsv("users.csv")) {
    users.set(u.user_id, {
      id: u.user_id,
      fullName: u.full_name,
      role: u.role as UserRole,
      departmentId: u.department_id,
      managerId: u.manager_id || null,
      approvalLimitCents: dollarsToCents(u.approval_limit_cad || "0"),
      status: u.status,
      statusSince: u.status_since || null,
      delegateId: u.delegate_user_id || null,
    });
  }

  const vendorRows = readCsv("vendors.csv");
  const vendors = new Map<string, VendorRec>();
  for (const v of vendorRows) vendors.set(v.vendor_id, { id: v.vendor_id, legalName: v.legal_name, status: v.status });

  const bankAccounts = buildBankAccounts(vendorRows, readCsv("bank_change_history.csv"));

  const payRows = readCsv("payments.csv");
  const approvalRows = readCsv("approvals.csv");
  const invoices = new Map<string, InvoiceRec>();
  const payments: PaymentRec[] = [];
  const approvals: PaymentsState["approvals"] = new Map();

  for (const r of readCsv("invoices.csv")) {
    const status = OPEN_INVOICE_STATUS[r.status];
    if (!status) continue;
    const scheduled = payRows.find((p) => p.invoice_id === r.invoice_id && p.status === "scheduled");
    // EFT only for now: cheque and card payments are a nice-to-have (payment-todo.md).
    if (scheduled && scheduled.method !== "EFT") continue;

    const totalCents = dollarsToCents(r.total);
    const invoice: InvoiceRec = {
      id: r.invoice_id,
      version: 1,
      status,
      vendorId: r.vendor_id,
      vendorInvoiceNumber: r.vendor_invoice_number,
      invoiceDate: r.invoice_date,
      dueDate: r.due_date,
      currency: r.currency as Currency,
      totalCents,
      totalCadCents: dollarsToCents(r.total_cad),
      fxRate: r.fx_rate_to_cad || "1",
      departmentId: r.department_id,
      requesterId: r.requester_user_id,
      isCreditNote: totalCents < 0,
    };
    invoices.set(invoice.id, invoice);
    approvals.set(invoice.id, {
      approverIds: approvalRows.filter((a) => a.invoice_id === invoice.id && a.action === "approved").map((a) => a.approver_user_id),
      basis: { vendorId: invoice.vendorId, currency: invoice.currency, totalCents },
    });

    if (scheduled) {
      const account = payableAccount(bankAccounts, invoice.vendorId);
      if (!account) continue;
      payments.push({
        paymentId: scheduled.payment_id,
        invoiceId: invoice.id,
        vendorId: invoice.vendorId,
        attemptNo: 1,
        status: "scheduled",
        method: scheduled.method as PaymentMethod,
        currency: scheduled.currency as Currency,
        amountCents: dollarsToCents(scheduled.amount),
        amountCadCents: dollarsToCents(scheduled.amount_cad),
        fxRateToCad: scheduled.fx_rate_to_cad || "1",
        scheduledDate: scheduled.scheduled_date,
        bankVersion: account.version,
        bankLast4: account.last4,
        releasedAt: null,
        settledAt: null,
        failedAt: null,
        failure: null,
        cancelledAt: null,
        cancelledBy: null,
        cancelReason: null,
        holdReason: null,
        preparedBy: scheduled.prepared_by,
        releasedBy: null,
        bankReference: null,
      });
    }
  }

  return {
    users,
    vendors,
    invoices,
    approvals,
    policies: policiesFromCsv(readCsv("approval_policies.csv") as unknown as PolicyCsvRow[]),
    bankAccounts,
    payments,
    flags: [],
    audit: [],
    invoiceFlags: new Map(),
    seq: 0,
  };
}

/**
 * vendors.csv holds the account currently on file; bank_change_history.csv says how it got there.
 * Each change is a new version. A change not verified by callback stays `pending`, and the last
 * verified version stays payable. Older versions only have their last 4 digits.
 */
function buildBankAccounts(vendorRows: Record<string, string>[], changeRows: Record<string, string>[]): BankAccountVersion[] {
  const out: BankAccountVersion[] = [];
  for (const v of vendorRows) {
    if (!v.bank_account) continue;
    const changes = changeRows.filter((c) => c.vendor_id === v.vendor_id).sort((a, b) => a.changed_at.localeCompare(b.changed_at));
    const base = { vendorId: v.vendor_id, currency: "CAD" as Currency, verifiedBy: null, verifiedAt: null, closedReason: null };
    const versions: BankAccountVersion[] = [];
    if (changes.length === 0) {
      versions.push({
        ...base, version: 1, status: "verified", institution: v.bank_institution || null, transit: v.bank_transit || null,
        account: v.bank_account, last4: v.bank_account.slice(-4), changedAt: null, channel: null, requestedBy: null,
      });
    } else {
      versions.push({
        ...base, version: 1, status: "verified", institution: null, transit: null, account: null,
        last4: changes[0].old_account_last4, changedAt: null, channel: null, requestedBy: null,
      });
      changes.forEach((c, i) => {
        const isCurrent = i === changes.length - 1;
        const verified = c.verified_by_callback === "yes";
        if (verified) for (const prev of versions) if (prev.status === "verified") prev.status = "superseded";
        versions.push({
          ...base, version: i + 2, status: verified ? "verified" : "pending",
          institution: isCurrent ? v.bank_institution || null : null,
          transit: isCurrent ? v.bank_transit || null : null,
          account: isCurrent ? v.bank_account : null,
          last4: c.new_account_last4, changedAt: c.changed_at, channel: c.request_channel, requestedBy: c.changed_by_user_id,
        });
      });
    }
    out.push(...versions);
  }
  return out;
}

function payableAccount(accounts: BankAccountVersion[], vendorId: string): BankAccountVersion | undefined {
  return accounts.find((a) => a.vendorId === vendorId && a.status === "verified");
}
