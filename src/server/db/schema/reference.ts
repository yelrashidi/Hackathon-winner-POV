import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

/**
 * Reference data, seeded from brim_ap_dataset/ by scripts/seed.ts (docs/architecture/data-model.md).
 * Ids are the dataset's own text ids (U001, V043, PO-2026-0001) so the contracts' string ids map
 * 1:1. Money is bigint cents (`*_cents`), rates are numeric — docs/rules/db.md.
 */

const cents = (name: string) => bigint(name, { mode: "number" });
const day = (name: string) => date(name, { mode: "string" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

export const USER_ROLES = ["employee", "ap_clerk", "approver", "finance_manager", "controller_admin", "auditor", "system"] as const;

export const departments = pgTable("departments", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  costCentre: text("cost_centre"),
  annualBudgetCents: cents("annual_budget_cents"),
  /** No FK: departments and users reference each other; the seed fills this after users. */
  managerId: text("manager_id"),
});

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    fullName: text("full_name").notNull(),
    email: text("email").notNull().unique(),
    title: text("title"),
    departmentId: text("department_id").references(() => departments.id),
    managerId: text("manager_id").references((): AnyPgColumn => users.id),
    /** `system` is the actor for automated steps (extraction, validation, seed) — never a person. */
    role: text("role").notNull(),
    approvalLimitCents: cents("approval_limit_cents").notNull().default(0),
    workProvince: text("work_province"),
    /** active | on_leave | terminated. Terminated users are kept so old records still resolve. */
    status: text("status").notNull().default("active"),
    statusSince: day("status_since"),
    delegateId: text("delegate_id").references((): AnyPgColumn => users.id),
    hireDate: day("hire_date"),
  },
  (t) => [check("users_role_check", sql`${t.role} IN ('employee','ap_clerk','approver','finance_manager','controller_admin','auditor','system')`)],
);

export const glAccounts = pgTable("gl_accounts", {
  accountNumber: text("account_number").primaryKey(),
  name: text("name").notNull(),
  accountType: text("account_type").notNull(),
  notes: text("notes"),
});

export const taxCodes = pgTable("tax_codes", {
  code: text("code").primaryKey(),
  description: text("description").notNull(),
  rate: numeric("rate").notNull(),
  appliesTo: text("applies_to").notNull(),
  recoverable: boolean("recoverable").notNull(),
  glAccount: text("gl_account").references(() => glAccounts.accountNumber),
});

export const vendors = pgTable("vendors", {
  id: text("id").primaryKey(),
  legalName: text("legal_name").notNull(),
  category: text("category").notNull(),
  defaultGlAccount: text("default_gl_account").references(() => glAccounts.accountNumber),
  address: text("address"),
  provinceOrState: text("province_or_state"),
  country: text("country"),
  gstHstNumber: text("gst_hst_number"),
  qstNumber: text("qst_number"),
  paymentTermsDays: integer("payment_terms_days"),
  earlyPayDiscount: text("early_pay_discount"),
  preferredPaymentMethod: text("preferred_payment_method"),
  acceptsCardPayment: boolean("accepts_card_payment").notNull().default(false),
  apContactEmail: text("ap_contact_email"),
  requiresPo: boolean("requires_po").notNull().default(false),
  /** active | pending_review | on_hold */
  status: text("status").notNull(),
  onboardedAt: day("onboarded_at"),
});

/**
 * A bank change is a NEW row, never an update (data-model.md). Payments point at the version they
 * paid to, so an auditor sees exactly which account received the money and who verified it.
 */
export const vendorBankAccounts = pgTable(
  "vendor_bank_accounts",
  {
    id: serial("id").primaryKey(),
    vendorId: text("vendor_id").notNull().references(() => vendors.id),
    version: integer("version").notNull(),
    /** pending | verified | rejected | superseded | closed */
    status: text("status").notNull(),
    /** Currency the account accepts (payments refuses USD to a CAD-only account). Dataset: CAD. */
    currency: text("currency").notNull().default("CAD"),
    institution: text("institution"),
    transit: text("transit"),
    /** Full number when known; older versions only have the last 4 digits. */
    account: text("account"),
    last4: text("last4").notNull(),
    /** When this version became the account on file; null for the original. */
    changedAt: day("changed_at"),
    /** phone_callback_verified | vendor_portal | email_request */
    channel: text("channel"),
    requestedBy: text("requested_by").references(() => users.id),
    verifiedBy: text("verified_by").references(() => users.id),
    verifiedAt: ts("verified_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("vendor_bank_accounts_vendor_version_uq").on(t.vendorId, t.version),
    // At most one payable account per vendor.
    uniqueIndex("vendor_bank_accounts_one_verified_uq").on(t.vendorId).where(sql`${t.status} = 'verified'`),
    check("vendor_bank_accounts_status_check", sql`${t.status} IN ('pending','verified','rejected','superseded','closed')`),
    // Two people: whoever requested a change cannot verify it.
    check("vendor_bank_accounts_currency_check", sql`${t.currency} IN ('CAD','USD')`),
    check("vendor_bank_accounts_two_people_check", sql`${t.verifiedBy} IS DISTINCT FROM ${t.requestedBy} OR ${t.verifiedBy} IS NULL`),
  ],
);

export const contracts = pgTable("contracts", {
  id: text("id").primaryKey(),
  vendorId: text("vendor_id").notNull().references(() => vendors.id),
  description: text("description").notNull(),
  /** fixed_monthly | rate_card | retainer | blanket */
  billingType: text("billing_type").notNull(),
  monthlyFeeCents: cents("monthly_fee_cents"),
  currency: text("currency").notNull(),
  hourlyRateCapCents: cents("hourly_rate_cap_cents"),
  fuelSurchargeCapPct: numeric("fuel_surcharge_cap_pct"),
  notToExceedMonthlyCents: cents("not_to_exceed_monthly_cents"),
  startDate: day("start_date").notNull(),
  endDate: day("end_date").notNull(),
  autoRenew: boolean("auto_renew").notNull().default(false),
  status: text("status").notNull(),
});

/** Remaining balance = total − invoices matched to it (policy P12): computed, never stored. */
export const purchaseOrders = pgTable("purchase_orders", {
  id: text("id").primaryKey(),
  vendorId: text("vendor_id").notNull().references(() => vendors.id),
  departmentId: text("department_id").references(() => departments.id),
  requesterId: text("requester_id").references(() => users.id),
  issueDate: day("issue_date"),
  description: text("description"),
  totalAmountCents: cents("total_amount_cents").notNull(),
  currency: text("currency").notNull(),
  /** open | partially_invoiced | closed */
  status: text("status").notNull(),
  approvedBy: text("approved_by").references(() => users.id),
});

export const fxRates = pgTable("fx_rates", {
  date: day("date").primaryKey(),
  usdToCad: numeric("usd_to_cad").notNull(),
});

export const cardTransactions = pgTable("card_transactions", {
  id: text("id").primaryKey(),
  cardId: text("card_id").notNull(),
  cardholderId: text("cardholder_id").references(() => users.id),
  postedDate: day("posted_date").notNull(),
  merchantDescriptor: text("merchant_descriptor").notNull(),
  mcc: text("mcc"),
  amountCents: cents("amount_cents").notNull(),
  currency: text("currency").notNull(),
  amountCadCents: cents("amount_cad_cents").notNull(),
  /** employee_card | ap_virtual_card */
  source: text("source").notNull(),
  receiptAttached: boolean("receipt_attached").notNull().default(false),
  memo: text("memo"),
  /** Matched by duplicates (feature 5); the dataset has no vendor id on card rows. */
  vendorId: text("vendor_id").references(() => vendors.id),
});

/**
 * Structured policies (src/contracts/approvals.ts → ApprovalPolicy). An edit is a new version
 * row, so every approval step can cite the exact policy text it was routed under.
 */
export const approvalPolicies = pgTable(
  "approval_policies",
  {
    id: text("id").notNull(),
    version: integer("version").notNull(),
    active: boolean("active").notNull(),
    /** approval | payment_release | match */
    ruleType: text("rule_type").notNull(),
    priority: integer("priority").notNull(),
    conditions: jsonb("conditions").notNull(),
    steps: jsonb("steps").notNull(),
    description: text("description").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.id, t.version] })],
);
