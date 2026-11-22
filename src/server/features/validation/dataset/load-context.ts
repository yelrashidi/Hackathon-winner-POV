import type {
  BankAccountVersion,
  ContractRef,
  FxRate,
  Office,
  PriorInvoice,
  PurchaseOrderRef,
  TaxCodeRef,
  ValidationContext,
  VendorRef,
} from "../context";
import { mulRate, parseMoneyToCents } from "../lib/money";
import { DATASET_AS_OF, readCsv } from "./csv";

/**
 * Builds a ValidationContext straight from the dataset CSVs — the same mapping scripts/seed.ts
 * will do into the database. Dev/test only: once the foundation lands, a DB loader replaces it.
 */

type Row = Record<string, string>;

const cents = (s: string | undefined): number | null => (s && s.trim() !== "" ? parseMoneyToCents(s) : null);
const orNull = (s: string | undefined): string | null => (s && s.trim() !== "" ? s.trim() : null);

/**
 * Harborline's delivery locations (brief: offices in Toronto, Vancouver, Calgary, Montréal).
 * Company reference data the DB would hold in an offices table; used only when an address has
 * no province code.
 */
export const HARBORLINE_OFFICES: readonly Office[] = [
  { id: "TOR", city: "Toronto", province: "ON", postalPrefix: "M5J" },
  { id: "VAN", city: "Vancouver", province: "BC", postalPrefix: "V6E" },
  { id: "CGY", city: "Calgary", province: "AB", postalPrefix: "T2P" },
  { id: "MTL", city: "Montreal", province: "QC", postalPrefix: "H3B" },
];

export function vendorsFrom(rows: Row[], invoiceRows: Row[]): VendorRef[] {
  const counts = new Map<string, number>();
  for (const r of invoiceRows) {
    if (r.status === "rejected") continue;
    counts.set(r.vendor_id!, (counts.get(r.vendor_id!) ?? 0) + 1);
  }
  return rows.map((r) => ({
    id: r.vendor_id!,
    legalName: r.legal_name!,
    category: r.category!,
    province: orNull(r.province_or_state),
    country: orNull(r.country),
    gstHstNumber: orNull(r.gst_hst_number),
    qstNumber: orNull(r.qst_number),
    paymentTermsDays: r.payment_terms_days ? Number(r.payment_terms_days) : null,
    requiresPo: r.requires_po === "yes",
    status: r.status!,
    contactEmail: orNull(r.ap_contact_email),
    onboardedAt: orNull(r.onboarded_at),
    invoiceCount: counts.get(r.vendor_id!) ?? 0,
  }));
}

/**
 * vendors.csv holds the CURRENT account; bank_change_history.csv holds each change (last 4
 * digits only). Rebuild the versions: the latest version whose change was verified by callback is
 * `verified`; later ones are `pending` (never verified); earlier ones `superseded`.
 */
export function bankAccountsFrom(vendorRows: Row[], changeRows: Row[]): BankAccountVersion[] {
  const out: BankAccountVersion[] = [];
  for (const v of vendorRows) {
    const account = orNull(v.bank_account);
    if (!account) continue;
    const changes = changeRows.filter((c) => c.vendor_id === v.vendor_id).sort((a, b) => a.changed_at!.localeCompare(b.changed_at!));
    // version i: 0 = before the first change; i ≥ 1 introduced by changes[i-1]
    const n = changes.length;
    let lastVerified = 0;
    for (let i = 1; i <= n; i++) if (changes[i - 1]!.verified_by_callback === "yes") lastVerified = i;
    for (let i = 0; i <= n; i++) {
      const isCurrent = i === n;
      const intro = i > 0 ? changes[i - 1]! : null;
      out.push({
        vendorId: v.vendor_id!,
        version: i + 1,
        status: i === lastVerified ? "verified" : i < lastVerified ? "superseded" : "pending",
        institution: isCurrent ? orNull(v.bank_institution) : null,
        transit: isCurrent ? orNull(v.bank_transit) : null,
        account: isCurrent ? account : null,
        last4: isCurrent ? account.slice(-4) : i === 0 ? changes[0]!.old_account_last4! : changes[i - 1]!.new_account_last4!,
        changedAt: intro ? intro.changed_at! : null,
        channel: intro ? intro.request_channel! : null,
      });
    }
  }
  return out;
}

export function purchaseOrdersFrom(rows: Row[]): PurchaseOrderRef[] {
  return rows.map((r) => ({
    id: r.po_id!,
    vendorId: r.vendor_id!,
    departmentId: orNull(r.department_id),
    totalCents: cents(r.total_amount) ?? 0,
    currency: r.currency!,
    status: r.status!,
    issueDate: orNull(r.issue_date),
  }));
}

export function contractsFrom(rows: Row[]): ContractRef[] {
  return rows.map((r) => ({
    id: r.contract_id!,
    vendorId: r.vendor_id!,
    description: r.description!,
    billingType: r.billing_type!,
    monthlyFeeCents: cents(r.monthly_fee),
    currency: r.currency!,
    hourlyRateCapCents: cents(r.hourly_rate_cap),
    fuelSurchargeCapPct: orNull(r.fuel_surcharge_cap_pct),
    notToExceedMonthlyCents: cents(r.not_to_exceed_monthly),
    startDate: r.start_date!,
    endDate: r.end_date!,
    autoRenew: r.auto_renew === "yes",
    status: r.status!,
  }));
}

export function priorInvoicesFrom(invoiceRows: Row[], lineRows: Row[]): PriorInvoice[] {
  const codes = new Map<string, Set<string>>();
  for (const l of lineRows) {
    const set = codes.get(l.invoice_id!) ?? new Set<string>();
    if (l.gst_hst_code) set.add(l.gst_hst_code);
    if (l.pst_qst_code) set.add(l.pst_qst_code);
    codes.set(l.invoice_id!, set);
  }
  return invoiceRows.map((r) => {
    const subtotal = cents(r.subtotal) ?? 0;
    const total = cents(r.total) ?? 0;
    const fx = r.fx_rate_to_cad && r.fx_rate_to_cad !== "" ? r.fx_rate_to_cad : "1";
    return {
      invoiceId: r.invoice_id!,
      vendorId: r.vendor_id!,
      invoiceNumber: r.vendor_invoice_number!,
      invoiceDate: r.invoice_date!,
      currency: r.currency!,
      subtotalCents: subtotal,
      totalCents: total,
      subtotalCadCents: r.currency === "CAD" ? subtotal : mulRate(subtotal, fx),
      totalCadCents: cents(r.total_cad) ?? (r.currency === "CAD" ? total : mulRate(total, fx)),
      poId: orNull(r.po_id),
      contractId: orNull(r.contract_id),
      status: r.status!,
      isCreditNote: total < 0,
      taxCodes: [...(codes.get(r.invoice_id!) ?? [])],
    };
  });
}

export function taxCodesFrom(rows: Row[]): TaxCodeRef[] {
  return rows.map((r) => ({
    code: r.code!,
    description: r.description!,
    rate: r.rate!,
    appliesTo: r.applies_to!,
    recoverable: r.recoverable!,
    glAccount: orNull(r.gl_account),
  }));
}

export function fxRatesFrom(rows: Row[]): FxRate[] {
  return rows.map((r) => ({ date: r.date!, usdToCad: r.usd_to_cad! }));
}

/**
 * Amount-tier boundaries from approval_policies.csv ("Invoice total over $10,000 CAD" → 1_000_000).
 * Once approvals' structured policies are in the DB, read their `amount_over` conditions instead.
 */
export function approvalThresholdsFrom(rows: Row[]): number[] {
  const out = new Set<number>();
  for (const r of rows) {
    if (r.rule_type !== "approval") continue;
    const m = /(?:over|up to)\s*\$\s*([\d,]+(?:\.\d{2})?)/i.exec(r.condition ?? "");
    if (m) out.add(parseMoneyToCents(m[1]!));
  }
  return [...out].sort((a, b) => a - b);
}

export interface DatasetTables {
  vendors: Row[];
  bankChanges: Row[];
  purchaseOrders: Row[];
  contracts: Row[];
  invoices: Row[];
  invoiceLines: Row[];
  taxCodes: Row[];
  fxRates: Row[];
  approvalPolicies: Row[];
}

export function readDatasetTables(dir?: string): DatasetTables {
  return {
    vendors: readCsv("vendors.csv", dir),
    bankChanges: readCsv("bank_change_history.csv", dir),
    purchaseOrders: readCsv("purchase_orders.csv", dir),
    contracts: readCsv("contracts.csv", dir),
    invoices: readCsv("invoices.csv", dir),
    invoiceLines: readCsv("invoice_lines.csv", dir),
    taxCodes: readCsv("tax_codes.csv", dir),
    fxRates: readCsv("fx_rates.csv", dir),
    approvalPolicies: readCsv("approval_policies.csv", dir),
  };
}

/** The full context: reference tables + every historical invoice as a prior invoice. */
export function loadDatasetContext(tables: DatasetTables = readDatasetTables(), today = DATASET_AS_OF): ValidationContext {
  return {
    today,
    vendors: vendorsFrom(tables.vendors, tables.invoices),
    bankAccounts: bankAccountsFrom(tables.vendors, tables.bankChanges),
    purchaseOrders: purchaseOrdersFrom(tables.purchaseOrders),
    contracts: contractsFrom(tables.contracts),
    priorInvoices: priorInvoicesFrom(tables.invoices, tables.invoiceLines),
    taxCodes: taxCodesFrom(tables.taxCodes),
    fxRates: fxRatesFrom(tables.fxRates),
    offices: HARBORLINE_OFFICES,
    approvalThresholdsCadCents: approvalThresholdsFrom(tables.approvalPolicies),
  };
}
