import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { SYSTEM_USER_ID } from "@/contracts/actor";
import { policiesFromCsv, type PolicyCsvRow } from "@/server/features/approvals";
import { validateAndPersist } from "@/server/features/validation/db/run";
import { DATA_DIR, DATASET_AS_OF, DATASET_DIR, readCsv } from "@/server/features/validation/dataset/csv";
import { historicalInputs } from "@/server/features/validation/dataset/history";
import { bankAccountsFrom, loadDatasetContext, readDatasetTables } from "@/server/features/validation/dataset/load-context";
import { parseMoneyToCents } from "@/server/features/validation/lib/money";
import type { Db } from "../client";
import * as s from "../schema";

/**
 * Loads the Harborline dataset (read-only input, docs/rules/db.md) into an EMPTY, migrated database.
 * Column names are mapped (`vendor_invoice_number` → `invoice_number`, dollars → `*_cents`) and the
 * CSV's invoice statuses are mapped onto the state machine (STATUS_MAP).
 *
 * History gets an audit trail too, so the auditor dashboard works from day one:
 *   invoice.imported  (actor: system, at the received date)
 *   approval.decided  (actor: the approver in approvals.csv, at acted_at)
 *   payment.scheduled / released / settled  (actors: prepared_by / released_by, at the CSV dates)
 * Every imported event carries metadata.imported = true, so nobody mistakes a reconstructed row for
 * one the app wrote live. Finally validation runs over every historical invoice through the real
 * path (validateAndPersist), so each invoice has its flags and an `invoice.validated` snapshot.
 *
 * Runs as the database OWNER (DATABASE_URL_ADMIN): it sets historical `occurred_at` values, which
 * the app role cannot.
 */

/** CSV status → state machine. `rejected` has no terminal state in the diagram; a rejected
 *  historical invoice is closed out as Voided, and the original word is kept in legacy_status. */
export const STATUS_MAP: Record<string, s.InvoiceStatus> = {
  pending_approval: "PendingApproval",
  approved: "Approved",
  scheduled: "PaymentScheduled",
  paid: "Paid",
  rejected: "Voided",
};

/** payments.csv status → payments.status. `outstanding` = released, not yet cleared the bank. */
const PAYMENT_STATUS_MAP: Record<string, string> = { settled: "settled", scheduled: "scheduled", outstanding: "released" };

type Row = Record<string, string>;
const cents = (v: string | undefined) => (v && v.trim() !== "" ? parseMoneyToCents(v) : null);
const orNull = (v: string | undefined) => (v && v.trim() !== "" ? v.trim() : null);
const yes = (v: string | undefined) => (v ?? "").trim().toLowerCase() === "yes";
const at = (dateOrTs: string) => (dateOrTs.length === 10 ? `${dateOrTs}T00:00:00Z` : `${dateOrTs}Z`);
export const normInvoiceNumber = (n: string) => n.toUpperCase().replace(/[\s-]/g, "");

async function insertChunked<T extends Record<string, unknown>>(db: Db, table: Parameters<Db["insert"]>[0], rows: T[], size = 400) {
  for (let i = 0; i < rows.length; i += size) await db.insert(table).values(rows.slice(i, i + size) as never);
}

export interface SeedOptions {
  dataDir?: string;
  /** Run validation over history (≈ 426 transactions). Default true. */
  validateHistory?: boolean;
  log?: (msg: string) => void;
}

export async function seedDatabase(db: Db, opts: SeedOptions = {}): Promise<Record<string, number>> {
  const dir = opts.dataDir ?? DATA_DIR;
  const log = opts.log ?? (() => {});
  const csv = (f: string) => readCsv(f, dir);
  const counts: Record<string, number> = {};

  // --- people & org -----------------------------------------------------------------------------
  const deptRows = csv("departments.csv");
  await insertChunked(db, s.departments, deptRows.map((d) => ({ id: d.department_id!, name: d.name!, costCentre: orNull(d.cost_centre), annualBudgetCents: cents(d.annual_budget_cad) })));

  const userRows = csv("users.csv");
  const users = new Map(userRows.map((u) => [u.user_id!, u]));
  await db.insert(s.users).values({ id: SYSTEM_USER_ID, fullName: "System (automated)", email: "system@harborline.invalid", role: "system", approvalLimitCents: 0, status: "active" });
  await insertChunked(
    db,
    s.users,
    userRows.map((u) => ({
      id: u.user_id!,
      fullName: u.full_name!,
      email: u.email!,
      title: orNull(u.title),
      departmentId: orNull(u.department_id),
      managerId: orNull(u.manager_id),
      role: u.role!,
      approvalLimitCents: cents(u.approval_limit_cad) ?? 0,
      workProvince: orNull(u.work_province),
      status: u.status!,
      statusSince: orNull(u.status_since),
      delegateId: orNull(u.delegate_user_id),
      hireDate: orNull(u.hire_date),
    })),
  );
  for (const d of deptRows) if (d.manager_user_id) await db.update(s.departments).set({ managerId: d.manager_user_id }).where(eq(s.departments.id, d.department_id!));
  counts.users = userRows.length + 1;

  // --- reference -------------------------------------------------------------------------------
  await insertChunked(db, s.glAccounts, csv("gl_accounts.csv").map((g) => ({ accountNumber: g.account_number!, name: g.name!, accountType: g.account_type!, notes: orNull(g.notes) })));
  await insertChunked(
    db,
    s.taxCodes,
    csv("tax_codes.csv").map((t) => ({ code: t.code!, description: t.description!, rate: t.rate!, appliesTo: t.applies_to!, recoverable: yes(t.recoverable), glAccount: orNull(t.gl_account) })),
  );

  const vendorRows = csv("vendors.csv");
  await insertChunked(
    db,
    s.vendors,
    vendorRows.map((v) => ({
      id: v.vendor_id!,
      legalName: v.legal_name!,
      category: v.category!,
      defaultGlAccount: orNull(v.default_gl_account),
      address: orNull(v.address),
      provinceOrState: orNull(v.province_or_state),
      country: orNull(v.country),
      gstHstNumber: orNull(v.gst_hst_number),
      qstNumber: orNull(v.qst_number),
      paymentTermsDays: v.payment_terms_days ? Number(v.payment_terms_days) : null,
      earlyPayDiscount: orNull(v.early_pay_discount),
      preferredPaymentMethod: orNull(v.preferred_payment_method),
      acceptsCardPayment: yes(v.accepts_card_payment),
      apContactEmail: orNull(v.ap_contact_email),
      requiresPo: yes(v.requires_po),
      status: v.status!,
      onboardedAt: orNull(v.onboarded_at),
    })),
  );
  counts.vendors = vendorRows.length;

  // Bank account versions: same reconstruction validation uses (bankAccountsFrom), plus who asked.
  const changeRows = csv("bank_change_history.csv");
  const versions = bankAccountsFrom(vendorRows, changeRows);
  const requester = (vendorId: string, changedAt: string | null) =>
    changedAt ? (changeRows.find((c) => c.vendor_id === vendorId && c.changed_at === changedAt)?.changed_by_user_id ?? null) : null;
  const insertedBank = versions.length
    ? await db
        .insert(s.vendorBankAccounts)
        .values(
          versions.map((b) => ({
            vendorId: b.vendorId,
            version: b.version,
            status: b.status,
            institution: b.institution,
            transit: b.transit,
            account: b.account,
            last4: b.last4,
            changedAt: b.changedAt,
            channel: b.channel,
            requestedBy: requester(b.vendorId, b.changedAt),
          })),
        )
        .returning({ id: s.vendorBankAccounts.id, vendorId: s.vendorBankAccounts.vendorId, version: s.vendorBankAccounts.version, changedAt: s.vendorBankAccounts.changedAt })
    : [];
  counts.vendorBankAccounts = insertedBank.length;

  await insertChunked(
    db,
    s.contracts,
    csv("contracts.csv").map((c) => ({
      id: c.contract_id!,
      vendorId: c.vendor_id!,
      description: c.description!,
      billingType: c.billing_type!,
      monthlyFeeCents: cents(c.monthly_fee),
      currency: c.currency!,
      hourlyRateCapCents: cents(c.hourly_rate_cap),
      fuelSurchargeCapPct: orNull(c.fuel_surcharge_cap_pct),
      notToExceedMonthlyCents: cents(c.not_to_exceed_monthly),
      startDate: c.start_date!,
      endDate: c.end_date!,
      autoRenew: yes(c.auto_renew),
      status: c.status!,
    })),
  );
  await insertChunked(
    db,
    s.purchaseOrders,
    csv("purchase_orders.csv").map((p) => ({
      id: p.po_id!,
      vendorId: p.vendor_id!,
      departmentId: orNull(p.department_id),
      requesterId: orNull(p.requester_user_id),
      issueDate: orNull(p.issue_date),
      description: orNull(p.description),
      totalAmountCents: cents(p.total_amount) ?? 0,
      currency: p.currency!,
      status: p.status!,
      approvedBy: orNull(p.approved_by),
    })),
  );
  await insertChunked(db, s.fxRates, csv("fx_rates.csv").map((f) => ({ date: f.date!, usdToCad: f.usd_to_cad! })));
  await insertChunked(
    db,
    s.cardTransactions,
    csv("card_transactions.csv").map((c) => ({
      id: c.txn_id!,
      cardId: c.card_id!,
      cardholderId: orNull(c.cardholder_user_id),
      postedDate: c.posted_date!,
      merchantDescriptor: c.merchant_descriptor!,
      mcc: orNull(c.mcc),
      amountCents: cents(c.amount) ?? 0,
      currency: c.currency!,
      amountCadCents: cents(c.amount_cad) ?? 0,
      source: c.source!,
      receiptAttached: yes(c.receipt_attached),
      memo: orNull(c.memo),
    })),
  );
  const policies = policiesFromCsv(csv("approval_policies.csv") as unknown as PolicyCsvRow[]);
  await insertChunked(
    db,
    s.approvalPolicies,
    policies.map((p) => ({ id: p.id, version: p.version, active: p.active, ruleType: p.ruleType, priority: p.priority, conditions: p.conditions, steps: p.steps, description: p.description })),
  );

  const emailsFile = path.join(opts.dataDir ? path.dirname(dir) : DATASET_DIR, "inbox", "emails.json");
  if (existsSync(emailsFile)) {
    const emails = JSON.parse(readFileSync(emailsFile, "utf8")) as Row[];
    await insertChunked(
      db,
      s.inboxMessages,
      emails.map((e) => ({ id: e.email_id!, receivedAt: at(e.received_at!), fromAddress: orNull(e.from_address), subject: orNull(e.subject), body: orNull(e.body), raw: e })),
    );
    counts.inboxMessages = emails.length;
  }

  // --- historical invoices -----------------------------------------------------------------------
  const tables = readDatasetTables(dir);
  const invoiceRows = tables.invoices;
  await insertChunked(
    db,
    s.invoices,
    invoiceRows.map((r) => {
      const total = cents(r.total) ?? 0;
      return {
        id: r.invoice_id!,
        status: STATUS_MAP[r.status!] ?? "InReview",
        legacyStatus: r.status!,
        version: 1,
        source: "historical",
        vendorId: r.vendor_id!,
        vendorNameRaw: vendorRows.find((v) => v.vendor_id === r.vendor_id)?.legal_name ?? null,
        invoiceNumber: r.vendor_invoice_number!,
        invoiceNumberNorm: normInvoiceNumber(r.vendor_invoice_number!),
        invoiceDate: orNull(r.invoice_date),
        receivedDate: orNull(r.received_date),
        dueDate: orNull(r.due_date),
        currency: r.currency!,
        subtotalCents: cents(r.subtotal),
        totalCents: total,
        totalCadCents: cents(r.total_cad),
        fxRate: orNull(r.fx_rate_to_cad) ?? "1",
        shipToProvince: orNull(r.ship_to_province),
        isCreditNote: total < 0,
        poId: orNull(r.po_id),
        contractId: orNull(r.contract_id),
        departmentId: orNull(r.department_id),
        requesterId: orNull(r.requester_user_id),
      };
    }),
  );
  counts.invoices = invoiceRows.length;

  await insertChunked(
    db,
    s.invoiceLines,
    tables.invoiceLines.map((l) => ({
      invoiceId: l.invoice_id!,
      lineNo: Number(l.line_no),
      description: l.description!,
      lineType: orNull(l.line_type),
      qty: orNull(l.quantity),
      unitPriceCents: cents(l.unit_price),
      amountCents: cents(l.amount) ?? 0,
      glAccountCode: orNull(l.gl_account),
      departmentId: orNull(l.department_id),
      gstHstCode: orNull(l.gst_hst_code),
      pstQstCode: orNull(l.pst_qst_code),
      codingSource: "accepted",
    })),
  );
  counts.invoiceLines = tables.invoiceLines.length;

  // Tax lines: the same per-invoice → per-line conversion validation's history replay uses.
  const inputs = historicalInputs(tables);
  const taxRows = inputs.flatMap((i) => (i.taxes ?? []).map((t) => ({ invoiceId: i.invoiceId, taxCode: t.code ?? null, label: t.label ?? null, amountCents: t.amountCents ?? 0 })));
  await insertChunked(db, s.invoiceTaxes, taxRows);
  counts.invoiceTaxes = taxRows.length;

  // --- approvals: one plan per historical invoice, one step per approvals.csv row ------------------
  const approvalRows = csv("approvals.csv");
  const approvalsBy = new Map<string, Row[]>();
  for (const a of approvalRows) approvalsBy.set(a.invoice_id!, [...(approvalsBy.get(a.invoice_id!) ?? []), a]);
  const planRows = [];
  const stepRows = [];
  for (const r of invoiceRows) {
    const steps = (approvalsBy.get(r.invoice_id!) ?? []).sort((a, b) => Number(a.step_no) - Number(b.step_no));
    if (!steps.length) continue;
    const planId = `${r.invoice_id}#1`;
    const totalCad = cents(r.total_cad) ?? 0;
    planRows.push({
      id: planId,
      invoiceId: r.invoice_id!,
      invoiceVersion: 1,
      attempt: 1,
      departmentId: orNull(r.department_id),
      outcome: "route",
      routingCadCents: Math.abs(totalCad),
      basis: { vendorId: r.vendor_id, currency: r.currency, totalCents: cents(r.total), totalCadCents: totalCad, requesterId: r.requester_user_id, poId: orNull(r.po_id) },
      notes: [{ policyId: null, message: "Imported from historical approvals (approvals.csv); routing reasons were not recorded in the source system." }],
      routedAt: at(r.received_date || r.invoice_date!),
    });
    for (const a of steps) {
      const u = users.get(a.approver_user_id!);
      stepRows.push({
        planId,
        invoiceId: r.invoice_id!,
        invoiceVersion: 1,
        seq: Number(a.step_no),
        role: a.approver_role!,
        reasons: [{ policyId: null, message: `Historical approval ${a.approval_id}` }],
        routedTo: a.approver_user_id!,
        assignedTo: a.approver_user_id!,
        decision: a.action === "rejected" ? "rejected" : "approved",
        actedBy: a.approver_user_id!,
        actedAs: u ? { fullName: u.full_name, role: u.role, approvalLimitCents: cents(u.approval_limit_cad) ?? 0 } : null,
        comment: orNull(a.comment),
        decidedAt: at(a.acted_at!),
      });
    }
  }
  await insertChunked(db, s.approvalPlans, planRows);
  const insertedSteps = stepRows.length
    ? await db.insert(s.approvalSteps).values(stepRows).returning({ id: s.approvalSteps.id, planId: s.approvalSteps.planId, seq: s.approvalSteps.seq })
    : [];
  const stepId = new Map(insertedSteps.map((x) => [`${x.planId}|${x.seq}`, x.id]));
  counts.approvalSteps = insertedSteps.length;

  // --- payments, linked to the bank-account version in effect on the payment date -----------------
  const bankBy = new Map<string, typeof insertedBank>();
  for (const b of insertedBank) bankBy.set(b.vendorId, [...(bankBy.get(b.vendorId) ?? []), b].sort((x, y) => x.version - y.version));
  const accountOn = (vendorId: string, date: string | null) => {
    const list = bankBy.get(vendorId) ?? [];
    let pick: (typeof list)[number] | undefined;
    for (const b of list) if (!b.changedAt || !date || b.changedAt <= date) pick = b;
    return pick?.id ?? null;
  };
  const paymentRows = csv("payments.csv");
  // Instalments of one invoice become attempts 1, 2, … in date order (payments.attempt_no).
  const attemptOf = new Map<string, number>();
  const seen = new Map<string, number>();
  for (const p of [...paymentRows].sort((a, b) => (a.scheduled_date || "").localeCompare(b.scheduled_date || "") || a.payment_id!.localeCompare(b.payment_id!))) {
    const n = (seen.get(p.invoice_id!) ?? 0) + 1;
    seen.set(p.invoice_id!, n);
    attemptOf.set(p.payment_id!, n);
  }
  await insertChunked(
    db,
    s.payments,
    paymentRows.map((p) => ({
      id: p.payment_id!,
      invoiceId: p.invoice_id!,
      attemptNo: attemptOf.get(p.payment_id!) ?? 1,
      vendorId: orNull(p.vendor_id),
      bankAccountId: p.method === "EFT" ? accountOn(p.vendor_id!, orNull(p.paid_date) ?? orNull(p.scheduled_date)) : null,
      method: p.method!,
      scheduledDate: orNull(p.scheduled_date),
      paidDate: orNull(p.paid_date),
      currency: p.currency!,
      amountCents: cents(p.amount) ?? 0,
      fxRate: orNull(p.fx_rate_to_cad) ?? "1",
      amountCadCents: cents(p.amount_cad) ?? 0,
      discountTakenCents: cents(p.discount_taken) ?? 0,
      reference: orNull(p.reference),
      status: PAYMENT_STATUS_MAP[p.status!] ?? p.status!,
      preparedBy: orNull(p.prepared_by),
      releasedBy: orNull(p.released_by),
      releasedAt: p.released_by && (p.paid_date || p.scheduled_date) ? at((p.paid_date || p.scheduled_date)!) : null,
      settledAt: p.status === "settled" && p.paid_date ? at(p.paid_date) : null,
    })),
  );
  counts.payments = paymentRows.length;

  // --- the reconstructed audit trail for history ---------------------------------------------------
  const roleOf = (userId: string) => (userId === SYSTEM_USER_ID ? "system" : (users.get(userId)?.role ?? "unknown"));
  const events: (typeof s.auditEvents.$inferInsert)[] = [];
  const ev = (e: Omit<typeof s.auditEvents.$inferInsert, "requestId" | "actorRole" | "metadata"> & { metadata?: Record<string, unknown> }) =>
    events.push({ ...e, requestId: randomUUID(), actorRole: roleOf(e.actorId), metadata: { imported: true, ...e.metadata } });

  for (const r of invoiceRows) {
    ev({
      occurredAt: at(r.received_date || r.invoice_date!),
      actorId: SYSTEM_USER_ID,
      action: "invoice.imported",
      entityType: "invoice",
      entityId: r.invoice_id!,
      invoiceId: r.invoice_id!,
      after: { status: STATUS_MAP[r.status!] ?? "InReview", legacyStatus: r.status, vendorId: r.vendor_id, invoiceNumber: r.vendor_invoice_number, totalCents: cents(r.total), currency: r.currency, totalCadCents: cents(r.total_cad) },
      reason: "Imported from Harborline history (invoices.csv)",
      metadata: { sourceFile: "invoices.csv" },
    });
  }
  for (const a of approvalRows) {
    const id = stepId.get(`${a.invoice_id}#1|${Number(a.step_no)}`);
    ev({
      occurredAt: at(a.acted_at!),
      actorId: a.approver_user_id!,
      action: "approval.decided",
      entityType: "approval_step",
      entityId: String(id ?? a.approval_id),
      invoiceId: a.invoice_id!,
      before: { decision: "pending" },
      after: { decision: a.action, seq: Number(a.step_no), role: a.approver_role },
      reason: orNull(a.comment),
      metadata: { sourceFile: "approvals.csv", approvalId: a.approval_id },
    });
  }
  for (const p of paymentRows) {
    const base = { entityType: "payment", entityId: p.payment_id!, invoiceId: p.invoice_id!, paymentId: p.payment_id!, metadata: { sourceFile: "payments.csv" } } as const;
    const status = PAYMENT_STATUS_MAP[p.status!] ?? p.status!;
    // scheduled_date is the PLANNED pay date and can be after the actual paid date; the moment it was
    // scheduled is not in the data, so the event sits at the earlier of the two, marked approximate.
    const scheduledAt = [p.scheduled_date, p.paid_date].filter((d): d is string => !!d).sort()[0];
    if (scheduledAt)
      ev({
        ...base,
        occurredAt: at(scheduledAt),
        actorId: p.prepared_by || SYSTEM_USER_ID,
        action: "payment.scheduled",
        after: { status: "scheduled", amountCents: cents(p.amount), currency: p.currency, method: p.method, plannedDate: orNull(p.scheduled_date) },
        metadata: { ...base.metadata, timeApproximate: true },
      });
    if (p.released_by) ev({ ...base, occurredAt: at(p.paid_date || p.scheduled_date!), actorId: p.released_by, action: "payment.released", before: { status: "scheduled" }, after: { status: "released", reference: p.reference } });
    if (status === "settled") ev({ ...base, occurredAt: at(p.paid_date || p.scheduled_date!), actorId: SYSTEM_USER_ID, action: "payment.settled", before: { status: "released" }, after: { status: "settled" } });
  }
  await insertChunked(db, s.auditEvents, events, 300);
  counts.auditEventsImported = events.length;
  log(`seeded reference data, ${invoiceRows.length} invoices and ${events.length} reconstructed audit events`);

  // --- validation over history, through the real path -----------------------------------------------
  if (opts.validateHistory !== false) {
    // Same replay context as scripts/validate-history.ts: purchase_orders.csv holds TODAY's status,
    // so POs these invoices used up are now "closed"; when each invoice arrived its PO was open.
    const ctx = loadDatasetContext({ ...tables, purchaseOrders: tables.purchaseOrders.map((p) => ({ ...p, status: "open" })) }, DATASET_AS_OF);
    let n = 0;
    for (const input of inputs) {
      await validateAndPersist(input, { db, ctx, today: DATASET_AS_OF, metadata: { replay: "historical" } });
      if (++n % 100 === 0) log(`validated ${n}/${inputs.length}`);
    }
    counts.validated = n;
  }
  return counts;
}
