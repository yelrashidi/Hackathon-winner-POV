import type { Flag } from "@/contracts/flag";
import type { ValidationInputDraft } from "@/contracts/validation";
import type { ValidationContext, VendorRef } from "../context";
import { HARBORLINE_OFFICES } from "../dataset/load-context";
import { validateInvoice, type ValidationResult } from "../engine";

/**
 * Small synthetic world for unit tests: independent of the dataset, so a rule test fails only
 * when the rule changes. Names are invented; tax rates are the real ones from tax_codes.
 */

export const vendor = (v: Partial<VendorRef> & Pick<VendorRef, "id" | "legalName">): VendorRef => ({
  category: "General",
  province: "ON",
  country: "CA",
  gstHstNumber: null,
  qstNumber: null,
  paymentTermsDays: 30,
  requiresPo: false,
  status: "active",
  contactEmail: null,
  onboardedAt: "2022-01-01",
  invoiceCount: 5,
  ...v,
});

export function baseContext(): ValidationContext {
  return {
    today: "2026-11-02",
    vendors: [
      vendor({ id: "V1", legalName: "Northwind Freight Ltd.", gstHstNumber: "111111118RT0001", contactEmail: "ar@northwind.example", invoiceCount: 10 }),
      vendor({ id: "V2", legalName: "Maple Office Supply Inc.", gstHstNumber: "222222226RT0001", contactEmail: "ar@mapleoffice.example", requiresPo: true, invoiceCount: 8 }),
      vendor({ id: "V3", legalName: "Conseil Laurier Inc.", province: "QC", gstHstNumber: "333333334RT0001", qstNumber: "1234567890TQ0001", contactEmail: "ar@laurier.example" }),
      vendor({ id: "V4", legalName: "Pacific Cloud LLC", province: "WA", country: "US", contactEmail: "billing@pacificcloud.example", invoiceCount: 6 }),
      vendor({ id: "V5", legalName: "Shieldsafe Insurance Brokers", gstHstNumber: "444444442RT0001", contactEmail: "ar@shieldsafe.example", invoiceCount: 4 }),
      vendor({ id: "V7", legalName: "Little Spoon Catering", province: "BC", contactEmail: "hello@littlespoon.example", invoiceCount: 2 }),
      vendor({ id: "V8", legalName: "Cloudly Software Inc.", gstHstNumber: "888888884RT0001", contactEmail: "ar@cloudly.example", invoiceCount: 9 }),
      vendor({ id: "V9", legalName: "Lex Partners LLP", gstHstNumber: "999999992RT0001", contactEmail: "ar@lexpartners.example", invoiceCount: 7 }),
    ],
    bankAccounts: [
      { vendorId: "V1", version: 1, status: "verified", institution: "001", transit: "12345", account: "1234567", last4: "4567", changedAt: null, channel: null },
      { vendorId: "V2", version: 1, status: "verified", institution: "002", transit: "22222", account: "2222222", last4: "2222", changedAt: null, channel: null },
    ],
    purchaseOrders: [
      { id: "PO-1", vendorId: "V2", departmentId: "D1", totalCents: 100000, currency: "CAD", status: "open", issueDate: "2026-09-01" },
      { id: "PO-2", vendorId: "V2", departmentId: "D1", totalCents: 50000, currency: "CAD", status: "closed", issueDate: "2026-01-01" },
      { id: "PO-3", vendorId: "V1", departmentId: "D1", totalCents: 500000, currency: "CAD", status: "open", issueDate: "2026-09-01" },
    ],
    contracts: [
      { id: "C-RATE", vendorId: "V1", description: "Freight rate card", billingType: "rate_card", monthlyFeeCents: null, currency: "CAD", hourlyRateCapCents: null, fuelSurchargeCapPct: "12", notToExceedMonthlyCents: 2_000_000, startDate: "2026-01-01", endDate: "2026-12-31", autoRenew: false, status: "active" },
      { id: "C-FIX", vendorId: "V8", description: "Subscription", billingType: "fixed_monthly", monthlyFeeCents: 100000, currency: "CAD", hourlyRateCapCents: null, fuelSurchargeCapPct: null, notToExceedMonthlyCents: null, startDate: "2026-01-01", endDate: "2026-12-31", autoRenew: true, status: "active" },
      { id: "C-HOUR", vendorId: "V9", description: "Legal retainer", billingType: "retainer", monthlyFeeCents: null, currency: "CAD", hourlyRateCapCents: 50000, fuelSurchargeCapPct: null, notToExceedMonthlyCents: 1_500_000, startDate: "2026-01-01", endDate: "2026-12-31", autoRenew: false, status: "active" },
    ],
    priorInvoices: [],
    taxCodes: [
      { code: "HST13", description: "Ontario HST 13%", rate: "0.13", appliesTo: "all", recoverable: "yes", glAccount: "1160" },
      { code: "GST5", description: "GST 5%", rate: "0.05", appliesTo: "all", recoverable: "yes", glAccount: "1160" },
      { code: "PST7_BC", description: "BC PST 7% (goods only)", rate: "0.07", appliesTo: "goods", recoverable: "no", glAccount: null },
      { code: "QST9975", description: "Quebec QST 9.975% (on pre-tax amount)", rate: "0.09975", appliesTo: "all", recoverable: "yes", glAccount: "1165" },
      { code: "EXEMPT", description: "Exempt supply, for example insurance premiums", rate: "0", appliesTo: "all", recoverable: "n/a", glAccount: null },
      { code: "FOREIGN", description: "Foreign vendor, no Canadian tax charged", rate: "0", appliesTo: "all", recoverable: "n/a", glAccount: null },
    ],
    fxRates: [
      { date: "2026-10-08", usdToCad: "1.3700" },
      { date: "2026-10-09", usdToCad: "1.3750" }, // Friday; 10-10 and 10-11 have no rate
      { date: "2026-10-12", usdToCad: "1.3800" },
    ],
    offices: HARBORLINE_OFFICES,
    approvalThresholdsCadCents: [1_000_000, 5_000_000, 25_000_000],
  };
}

/** A clean invoice: Northwind Freight, delivered to Toronto, ON HST, adds up, remits to the verified account. */
export function baseInput(): ValidationInputDraft {
  return {
    invoiceId: "T-1",
    documentType: "invoice",
    vendor: { nameRaw: "Northwind Freight Ltd.", gstHstNumber: "111111118RT0001", qstNumber: null, province: "ON", country: "CA" },
    senderEmail: "ar@northwind.example",
    invoiceNumber: "NW-1001",
    invoiceDate: "2026-10-10",
    dueDate: "2026-11-09",
    receivedDate: "2026-10-11",
    currency: "CAD",
    paymentTermsDays: 30,
    poNumber: null,
    billTo: { name: "Harborline Logistics Inc.", address: "88 Queens Quay W, Suite 1400, Toronto ON M5J 0B8", province: "ON" },
    lines: [
      { lineNo: 1, description: "LTL shipment Toronto-Ottawa", quantity: 1, unitPriceCents: 100000, amountCents: 100000, lineType: "services" },
      { lineNo: 2, description: "LTL shipment Ottawa-Montreal", quantity: 1, unitPriceCents: 50000, amountCents: 50000, lineType: "services" },
    ],
    taxes: [{ code: "HST13", label: "HST (13%)", ratePct: 13, amountCents: 19500 }],
    subtotalCents: 150000,
    totalCents: 169500,
    remitTo: { institution: "001", transit: "12345", account: "1234567" },
  };
}

/** Re-totals an input after its lines/taxes changed, so a case only breaks what it means to. */
export function retotal(i: ValidationInputDraft): ValidationInputDraft {
  const sub = (i.lines ?? []).reduce((s, l) => s + l.amountCents, 0);
  const tax = (i.taxes ?? []).reduce((s, t) => s + t.amountCents, 0);
  return { ...i, subtotalCents: sub, totalCents: sub + tax };
}

export interface Case {
  name: string;
  input?: (i: ValidationInputDraft) => ValidationInputDraft;
  ctx?: (c: ValidationContext) => ValidationContext;
  /** The exact set of codes the whole engine must raise (empty = clean). */
  expect: string[];
  check?: (r: ValidationResult, flags: Record<string, Flag>) => void;
}

export function runCase(c: Case): ValidationResult {
  const ctx = c.ctx ? c.ctx(baseContext()) : baseContext();
  const input = c.input ? c.input(baseInput()) : baseInput();
  return validateInvoice(input, ctx);
}

export const codesOf = (r: ValidationResult): string[] => [...new Set(r.flags.map((f) => f.code))].sort();
export const byCode = (r: ValidationResult): Record<string, Flag> => Object.fromEntries(r.flags.map((f) => [f.code, f]));
