import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { contracts, departments, glAccounts, purchaseOrders, users, vendorBankAccounts, vendors } from "./reference";

/**
 * The pipeline: what our app writes as an invoice goes inbox → read → code → check → approve → pay.
 * Historical invoices live in the SAME tables (`source = 'historical'`), so duplicate search and
 * the audit view are one query over everything (data-model.md).
 */

const cents = (name: string) => bigint(name, { mode: "number" });
const day = (name: string) => date(name, { mode: "string" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

/** The state machine's statuses (docs/explainers/brim-ap-diagrams.md). Only fire() changes them. */
export const INVOICE_STATUSES = [
  "Received",
  "ManualEntry",
  "InReview",
  "OnHold",
  "PendingApproval",
  "Approved",
  "PaymentScheduled",
  "Paid",
  "Voided",
  "Closed",
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(","));

export const inboxMessages = pgTable("inbox_messages", {
  id: text("id").primaryKey(),
  receivedAt: ts("received_at").notNull(),
  fromAddress: text("from_address"),
  subject: text("subject"),
  body: text("body"),
  /** invoice | statement | inquiry | spam | … (intake's LLM classification) */
  classification: text("classification"),
  raw: jsonb("raw"),
});

/** The source file lives once; sha256 catches byte-identical resubmissions for free. */
export const documents = pgTable(
  "documents",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
    inboxMessageId: text("inbox_message_id").references(() => inboxMessages.id),
    storageKey: text("storage_key").notNull(),
    fileName: text("file_name"),
    mime: text("mime"),
    sha256: text("sha256").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("documents_sha256_idx").on(t.sha256)],
);

export const invoices = pgTable(
  "invoices",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
    status: text("status").notNull(),
    /** Status as written in the source system for imported history (e.g. `rejected`). */
    legacyStatus: text("legacy_status"),
    /** Bumps on a material edit; approvals tied to an older version are void. */
    version: integer("version").notNull().default(1),
    /** historical | email | upload | manual */
    source: text("source").notNull(),
    documentId: text("document_id").references(() => documents.id),
    vendorId: text("vendor_id").references(() => vendors.id),
    vendorNameRaw: text("vendor_name_raw"),
    invoiceNumber: text("invoice_number"),
    /** Upper case, no spaces or dashes: what duplicate search indexes. */
    invoiceNumberNorm: text("invoice_number_norm"),
    invoiceDate: day("invoice_date"),
    receivedDate: day("received_date"),
    dueDate: day("due_date"),
    /** Nullable: a partially read invoice is still saved, and validation flags what is missing. */
    currency: text("currency"),
    subtotalCents: cents("subtotal_cents"),
    totalCents: cents("total_cents"),
    /** Converted at the invoice-date rate; every limit is compared on this. */
    totalCadCents: cents("total_cad_cents"),
    /** The USD→CAD rate used (1 for CAD). Stored so the conversion is reproducible later. */
    fxRate: numeric("fx_rate"),
    shipToProvince: text("ship_to_province"),
    isCreditNote: boolean("is_credit_note").notNull().default(false),
    poId: text("po_id").references(() => purchaseOrders.id),
    contractId: text("contract_id").references(() => contracts.id),
    departmentId: text("department_id").references(() => departments.id),
    requesterId: text("requester_id").references(() => users.id),
    /** Exactly what extraction returned, before any human edit: the original evidence. */
    extractionRaw: jsonb("extraction_raw"),
    extractionConfidence: jsonb("extraction_confidence"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("invoices_status_check", sql`${t.status} IN (${inList(INVOICE_STATUSES)})`),
    check("invoices_source_check", sql`${t.source} IN ('historical','email','upload','manual')`),
    // Last line of defence against PAYING an exact duplicate, even if a code path skips the check:
    // two invoices with the same vendor + number can never both be in approval or paid. A duplicate
    // can still be RECEIVED and reviewed (so it can be flagged and voided). History is imported as
    // delivered — it contains paid duplicates, which is the point of the duplicates feature.
    uniqueIndex("invoices_vendor_number_uq")
      .on(t.vendorId, t.invoiceNumberNorm)
      .where(sql`${t.status} IN ('PendingApproval','Approved','PaymentScheduled','Paid') AND ${t.source} <> 'historical'`),
    index("invoices_vendor_number_idx").on(t.vendorId, t.invoiceNumberNorm),
    index("invoices_status_idx").on(t.status),
    index("invoices_invoice_date_idx").on(t.invoiceDate),
  ],
);

export const invoiceLines = pgTable(
  "invoice_lines",
  {
    id: serial("id").primaryKey(),
    invoiceId: text("invoice_id").notNull().references(() => invoices.id),
    lineNo: integer("line_no").notNull(),
    description: text("description").notNull(),
    /** goods | services */
    lineType: text("line_type"),
    qty: numeric("qty"),
    unitPriceCents: cents("unit_price_cents"),
    amountCents: cents("amount_cents").notNull(),
    glAccountCode: text("gl_account_code").references(() => glAccounts.accountNumber),
    departmentId: text("department_id").references(() => departments.id),
    gstHstCode: text("gst_hst_code"),
    pstQstCode: text("pst_qst_code"),
    /** suggested | accepted | changed — the suggestion and the human choice are both kept. */
    codingSource: text("coding_source"),
    codingReason: jsonb("coding_reason"),
  },
  (t) => [uniqueIndex("invoice_lines_invoice_line_uq").on(t.invoiceId, t.lineNo)],
);

/** One row per tax line (GST and PST are two rows), mapped to the provided codes. */
export const invoiceTaxes = pgTable(
  "invoice_taxes",
  {
    id: serial("id").primaryKey(),
    invoiceId: text("invoice_id").notNull().references(() => invoices.id),
    /** As extraction mapped it. No FK on purpose: an unknown code is kept so validation can flag it. */
    taxCode: text("tax_code"),
    label: text("label"),
    baseCents: cents("base_cents"),
    rate: numeric("rate"),
    amountCents: cents("amount_cents").notNull(),
  },
  (t) => [index("invoice_taxes_invoice_idx").on(t.invoiceId)],
);

/**
 * Mirrors src/contracts/flag.ts. Validation and duplicates write here; `block` flags stop submit.
 * `flag_key` (validation's flagKey(): code|field|line) gives a flag one row across re-runs, so a
 * human resolution is never lost when the invoice is re-validated.
 */
export const invoiceFlags = pgTable(
  "invoice_flags",
  {
    id: serial("id").primaryKey(),
    invoiceId: text("invoice_id").notNull().references(() => invoices.id),
    /** Invoice version the flag was last raised on. */
    invoiceVersion: integer("invoice_version").notNull(),
    /** validation | duplicates | coding */
    source: text("source").notNull(),
    flagKey: text("flag_key").notNull(),
    code: text("code").notNull(),
    severity: text("severity").notNull(),
    message: text("message").notNull(),
    evidence: jsonb("evidence").notNull().default({}),
    relatedInvoiceId: text("related_invoice_id"),
    relatedCardTxnId: text("related_card_txn_id"),
    status: text("status").notNull().default("open"),
    resolvedBy: text("resolved_by").references(() => users.id),
    resolvedAt: ts("resolved_at"),
    resolutionNote: text("resolution_note"),
    raisedAt: ts("raised_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("invoice_flags_identity_uq").on(t.invoiceId, t.source, t.flagKey),
    index("invoice_flags_invoice_idx").on(t.invoiceId),
    check("invoice_flags_severity_check", sql`${t.severity} IN ('block','warn','info')`),
    check("invoice_flags_status_check", sql`${t.status} IN ('open','resolved','overridden')`),
    check("invoice_flags_source_check", sql`${t.source} IN ('validation','duplicates','coding')`),
    // An override without a reason is impossible, even if a code path forgets to ask for one.
    check("invoice_flags_override_note_check", sql`${t.status} <> 'overridden' OR length(trim(coalesce(${t.resolutionNote}, ''))) > 0`),
    check("invoice_flags_resolver_check", sql`${t.status} = 'open' OR ${t.resolvedBy} IS NOT NULL`),
  ],
);

/**
 * One routing of one invoice version (approvals' ApprovalPlan, proposal in 6-approvals.md).
 * Plans are appended, never overwritten: every resubmit is a new attempt.
 */
export const approvalPlans = pgTable(
  "approval_plans",
  {
    /** `${invoiceId}#${attempt}` — the approvals store's planId. */
    id: text("id").primaryKey(),
    invoiceId: text("invoice_id").notNull().references(() => invoices.id),
    invoiceVersion: integer("invoice_version").notNull(),
    attempt: integer("attempt").notNull(),
    departmentId: text("department_id"),
    /** route | hold | blocked */
    outcome: text("outcome").notNull(),
    routingCadCents: cents("routing_cad_cents").notNull(),
    basis: jsonb("basis").notNull(),
    excludedApprovers: jsonb("excluded_approvers").notNull().default([]),
    attention: jsonb("attention").notNull().default([]),
    holdReasons: jsonb("hold_reasons").notNull().default([]),
    notes: jsonb("notes").notNull().default([]),
    routedAt: ts("routed_at").notNull(),
  },
  (t) => [uniqueIndex("approval_plans_invoice_attempt_uq").on(t.invoiceId, t.attempt)],
);

/** `acted_by` + `on_behalf_of` is how a delegate action is recorded. */
export const approvalSteps = pgTable(
  "approval_steps",
  {
    id: serial("id").primaryKey(),
    planId: text("plan_id").notNull().references(() => approvalPlans.id),
    invoiceId: text("invoice_id").notNull().references(() => invoices.id),
    invoiceVersion: integer("invoice_version").notNull(),
    seq: integer("seq").notNull(),
    /** dept_manager | finance_manager | controller_admin | cfo */
    role: text("role").notNull(),
    alsoCovers: jsonb("also_covers").notNull().default([]),
    policyId: text("policy_id"),
    policyVersion: integer("policy_version"),
    reasons: jsonb("reasons").notNull().default([]),
    routedTo: text("routed_to").references(() => users.id),
    assignedTo: text("assigned_to").references(() => users.id),
    onBehalfOf: text("on_behalf_of").references(() => users.id),
    resolution: jsonb("resolution").notNull().default([]),
    /** pending | approved | rejected */
    decision: text("decision").notNull().default("pending"),
    actedBy: text("acted_by").references(() => users.id),
    /** Name, role and limit WHEN they acted — titles and limits change later. */
    actedAs: jsonb("acted_as"),
    acknowledgedFlags: jsonb("acknowledged_flags").notNull().default([]),
    comment: text("comment"),
    decidedAt: ts("decided_at"),
  },
  (t) => [
    uniqueIndex("approval_steps_plan_seq_uq").on(t.planId, t.seq),
    index("approval_steps_invoice_idx").on(t.invoiceId),
    check("approval_steps_decision_check", sql`${t.decision} IN ('pending','approved','rejected')`),
  ],
);

/**
 * One payment ATTEMPT (src/contracts/payment.ts → PaymentRecord). A retry is a new row with
 * attempt_no + 1; a final status (settled / failed / cancelled) never moves again.
 */
export const payments = pgTable(
  "payments",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
    invoiceId: text("invoice_id").notNull().references(() => invoices.id),
    attemptNo: integer("attempt_no").notNull().default(1),
    vendorId: text("vendor_id").references(() => vendors.id),
    /** The exact bank-account version paid to (null for card / cheque). */
    bankAccountId: integer("bank_account_id").references(() => vendorBankAccounts.id),
    /** EFT | CARD | CHEQUE */
    method: text("method").notNull(),
    scheduledDate: day("scheduled_date"),
    paidDate: day("paid_date"),
    currency: text("currency").notNull(),
    amountCents: cents("amount_cents").notNull(),
    fxRate: numeric("fx_rate"),
    amountCadCents: cents("amount_cad_cents").notNull(),
    discountTakenCents: cents("discount_taken_cents").notNull().default(0),
    reference: text("reference"),
    /** scheduled | on_hold | released | settled | failed | cancelled (PaymentStatus) */
    status: text("status").notNull(),
    preparedBy: text("prepared_by").references(() => users.id),
    releasedBy: text("released_by").references(() => users.id),
    releasedAt: ts("released_at"),
    settledAt: ts("settled_at"),
    failedAt: ts("failed_at"),
    /** FailureCode, plus the PaymentFailure detail. */
    failureCode: text("failure_code"),
    failure: jsonb("failure"),
    cancelledAt: ts("cancelled_at"),
    cancelledBy: text("cancelled_by").references(() => users.id),
    cancelReason: text("cancel_reason"),
    holdReason: text("hold_reason"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("payments_invoice_idx").on(t.invoiceId),
    uniqueIndex("payments_invoice_attempt_uq").on(t.invoiceId, t.attemptNo),
    check("payments_status_check", sql`${t.status} IN ('scheduled','on_hold','released','settled','failed','cancelled')`),
    // Separation of duties, the cheap half: whoever prepared a payment cannot release it.
    check("payments_release_not_preparer_check", sql`${t.releasedBy} IS DISTINCT FROM ${t.preparedBy} OR ${t.releasedBy} IS NULL`),
    check("payments_cancel_reason_check", sql`${t.status} <> 'cancelled' OR ${t.cancelReason} IS NOT NULL OR ${t.cancelledBy} IS NULL`),
  ],
);

/** Payments' urgency flags (src/contracts/payment.ts → PaymentFlag), raised by a failed attempt. */
export const paymentFlags = pgTable(
  "payment_flags",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
    /** critical | high | low */
    urgency: text("urgency").notNull(),
    /** FailureCode */
    reasonCode: text("reason_code").notNull(),
    message: text("message").notNull(),
    /** supplier: every payment to vendor_id. payment: only payment_id. */
    scope: text("scope").notNull(),
    vendorId: text("vendor_id").notNull().references(() => vendors.id),
    paymentId: text("payment_id").notNull().references(() => payments.id),
    createdAt: ts("created_at").notNull().defaultNow(),
    clearedBy: text("cleared_by").references(() => users.id),
    clearedAt: ts("cleared_at"),
    clearNote: text("clear_note"),
    clearedAutomatically: boolean("cleared_automatically").notNull().default(false),
  },
  (t) => [
    index("payment_flags_vendor_idx").on(t.vendorId),
    index("payment_flags_payment_idx").on(t.paymentId),
    check("payment_flags_urgency_check", sql`${t.urgency} IN ('critical','high','low')`),
    check("payment_flags_scope_check", sql`${t.scope} IN ('supplier','payment')`),
  ],
);
