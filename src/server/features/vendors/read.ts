import { and, asc, desc, eq, gte, inArray, like, lt, notInArray, or, sql } from "drizzle-orm";
import type { Actor } from "@/contracts/actor";
import { VendorListQuery, type AllowedAction, type VendorDetail, type VendorList, type VendorListQuery as VendorListQueryInput, type VendorRow, type VendorStatus } from "@/contracts/vendor";
import { authorize, Forbidden, type Action } from "@/server/core/authorize";
import { getDb, type Db } from "@/server/db/client";
import { auditEvents, contracts, invoiceFlags, invoices, purchaseOrders, users, vendorBankAccounts, vendors } from "@/server/db/schema";
import { iso, loadPeople } from "@/server/features/audit/shared";
import { toTimelineEvent } from "@/server/features/audit/timeline";
import { checkActorActive, checkApprove, checkBankDecision, checkHold, checkReleaseHold, type Reason } from "./rules";
import { bankVersions, guardView, loadVendorState, notFound, todayIso } from "./shared";

/**
 * Feature 9 — the vendor master screens (read-only). Gated by `vendor.view`: AP Clerk, Finance
 * Manager, Controller, Auditor. Bank accounts show the last 4 digits only.
 *
 *   listVendors(actor, query)        screen 1: every vendor with status, bank state, open work, spend
 *   getVendorDetail(actor, vendorId) screen 2: one vendor — fields, bank versions, contracts, POs,
 *                                    invoices, its audit timeline, and which buttons the viewer may press
 */

/** An invoice that is finished no longer counts as open work. */
const CLOSED = ["Paid", "Voided", "Closed"];
/** What counts as spend. */
const SPEND = ["Approved", "PaymentScheduled", "Paid"];

export async function listVendors(actor: Actor, query: VendorListQueryInput = {}, opts: { db?: Db; today?: string } = {}): Promise<VendorList> {
  const db = opts.db ?? getDb();
  await guardView(actor, db);
  const q = VendorListQuery.parse(query);
  const year = (opts.today ?? todayIso()).slice(0, 4);

  // Small tables (tens of vendors): load and join in code — easier to read than one big query.
  const [all, banks, openInvoices, openFlags, spend] = await Promise.all([
    db.select().from(vendors).orderBy(asc(vendors.legalName)),
    db.select({ vendorId: vendorBankAccounts.vendorId, status: vendorBankAccounts.status, last4: vendorBankAccounts.last4 }).from(vendorBankAccounts).where(inArray(vendorBankAccounts.status, ["verified", "pending"])),
    db.select({ vendorId: invoices.vendorId, n: sql<number>`count(*)::int` }).from(invoices).where(notInArray(invoices.status, CLOSED)).groupBy(invoices.vendorId),
    db
      .select({ vendorId: invoices.vendorId, n: sql<number>`count(*)::int` })
      .from(invoiceFlags)
      .innerJoin(invoices, eq(invoiceFlags.invoiceId, invoices.id))
      .where(and(eq(invoiceFlags.status, "open"), notInArray(invoices.status, CLOSED)))
      .groupBy(invoices.vendorId),
    db
      .select({ vendorId: invoices.vendorId, cents: sql<string>`coalesce(sum(${invoices.totalCadCents}), 0)::text` })
      .from(invoices)
      .where(and(inArray(invoices.status, SPEND), gte(invoices.invoiceDate, `${year}-01-01`), lt(invoices.invoiceDate, `${Number(year) + 1}-01-01`)))
      .groupBy(invoices.vendorId),
  ]);
  const count = (rows: { vendorId: string | null; n: number }[], id: string) => rows.find((r) => r.vendorId === id)?.n ?? 0;

  const rows: VendorRow[] = all.map((v) => ({
    vendorId: v.id,
    legalName: v.legalName,
    category: v.category,
    status: v.status as VendorStatus,
    provinceOrState: v.provinceOrState,
    country: v.country,
    preferredPaymentMethod: v.preferredPaymentMethod,
    requiresPo: v.requiresPo,
    verifiedAccountLast4: banks.find((b) => b.vendorId === v.id && b.status === "verified")?.last4 ?? null,
    pendingBankChange: banks.some((b) => b.vendorId === v.id && b.status === "pending"),
    openInvoices: count(openInvoices, v.id),
    openFlags: count(openFlags, v.id),
    spendYtdCadCents: Number(spend.find((s) => s.vendorId === v.id)?.cents ?? 0),
    onboardedAt: v.onboardedAt,
  }));

  const search = q.search?.toLowerCase();
  const gst = new Map(all.map((v) => [v.id, `${v.gstHstNumber ?? ""} ${v.apContactEmail ?? ""}`.toLowerCase()]));
  const filtered = rows.filter(
    (r) =>
      (!search || `${r.vendorId} ${r.legalName}`.toLowerCase().includes(search) || gst.get(r.vendorId)!.includes(search)) &&
      (!q.status || r.status === q.status) &&
      (!q.category || r.category === q.category) &&
      (q.pendingBankChange === undefined || r.pendingBankChange === q.pendingBankChange),
  );
  const start = (q.page - 1) * q.pageSize;
  return {
    rows: filtered.slice(start, start + q.pageSize),
    total: filtered.length,
    page: q.page,
    pageSize: q.pageSize,
    categories: [...new Set(all.map((v) => v.category))].sort(),
    counts: {
      pending_review: rows.filter((r) => r.status === "pending_review").length,
      active: rows.filter((r) => r.status === "active").length,
      on_hold: rows.filter((r) => r.status === "on_hold").length,
      pendingBankChanges: rows.filter((r) => r.pendingBankChange).length,
    },
  };
}

export async function getVendorDetail(actor: Actor, vendorId: string, opts: { db?: Db } = {}): Promise<VendorDetail> {
  const db = opts.db ?? getDb();
  const viewer = await guardView(actor, db, vendorId);
  const v = await loadVendorState(db, vendorId);
  if (!v) throw notFound(vendorId);
  const row = v.row;

  const [people, versions, contractRows, poRows, invoiceRows, events, [me]] = await Promise.all([
    loadPeople(db),
    bankVersions(db, vendorId),
    db.select().from(contracts).where(eq(contracts.vendorId, vendorId)).orderBy(asc(contracts.startDate)),
    db.select().from(purchaseOrders).where(eq(purchaseOrders.vendorId, vendorId)).orderBy(desc(purchaseOrders.issueDate)),
    db
      .select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber, invoiceDate: invoices.invoiceDate, status: invoices.status, totalCents: invoices.totalCents, currency: invoices.currency })
      .from(invoices)
      .where(eq(invoices.vendorId, vendorId))
      .orderBy(sql`${invoices.invoiceDate} DESC NULLS LAST`, desc(invoices.id))
      .limit(25),
    db
      .select()
      .from(auditEvents)
      .where(or(and(eq(auditEvents.entityType, "vendor"), eq(auditEvents.entityId, vendorId)), and(eq(auditEvents.entityType, "bank_account"), like(auditEvents.entityId, `${vendorId}#%`))))
      .orderBy(asc(auditEvents.occurredAt), asc(auditEvents.id)),
    db.select({ id: users.id, fullName: users.fullName, status: users.status }).from(users).where(eq(users.id, viewer.userId)),
  ]);

  const flagCounts = invoiceRows.length
    ? await db
        .select({ invoiceId: invoiceFlags.invoiceId, n: sql<number>`count(*)::int` })
        .from(invoiceFlags)
        .where(and(eq(invoiceFlags.status, "open"), inArray(invoiceFlags.invoiceId, invoiceRows.map((i) => i.id))))
        .groupBy(invoiceFlags.invoiceId)
    : [];

  // Which buttons this viewer may press, and why not — the same rules the write actions run.
  const pending = versions.find((a) => a.status === "pending");
  const person = { id: viewer.userId, fullName: me?.fullName ?? viewer.userId };
  const allowed = (action: Action, rules: Reason[]): AllowedAction => {
    try {
      authorize(actor, action);
    } catch (err) {
      if (err instanceof Forbidden) return { allowed: false, reason: err.reason };
      throw err;
    }
    const why = [...checkActorActive(me), ...rules];
    return why.length ? { allowed: false, reason: why.map((r) => r.message).join(" ") } : { allowed: true, reason: null };
  };

  return {
    vendor: {
      vendorId: row.id,
      legalName: row.legalName,
      category: row.category,
      status: row.status as VendorStatus,
      statusReason: v.history.statusReason,
      address: row.address,
      provinceOrState: row.provinceOrState,
      country: row.country,
      gstHstNumber: row.gstHstNumber,
      qstNumber: row.qstNumber,
      paymentTermsDays: row.paymentTermsDays,
      earlyPayDiscount: row.earlyPayDiscount,
      preferredPaymentMethod: row.preferredPaymentMethod,
      acceptsCardPayment: row.acceptsCardPayment,
      apContactEmail: row.apContactEmail,
      requiresPo: row.requiresPo,
      defaultGlAccount: row.defaultGlAccount,
      onboardedAt: row.onboardedAt,
      onboardedBy: people(v.history.onboardedBy),
      approvedBy: people(v.history.approvedBy),
    },
    // Deliberately no institution / transit / account here: last 4 digits only.
    bankAccounts: versions.map((b) => ({
      version: b.version,
      status: b.status,
      currency: b.currency,
      last4: b.last4,
      channel: b.channel,
      changedAt: b.changedAt,
      requestedBy: people(b.requestedBy),
      verifiedBy: people(b.verifiedBy),
      verifiedAt: iso(b.verifiedAt),
    })),
    contracts: contractRows.map((c) => ({ contractId: c.id, description: c.description, billingType: c.billingType, status: c.status, startDate: c.startDate, endDate: c.endDate })),
    purchaseOrders: poRows.map((p) => ({ poId: p.id, description: p.description, status: p.status, totalAmountCents: p.totalAmountCents, currency: p.currency })),
    invoices: invoiceRows.map((i) => ({
      invoiceId: i.id,
      invoiceNumber: i.invoiceNumber,
      invoiceDate: i.invoiceDate,
      status: i.status,
      totalCents: i.totalCents,
      currency: i.currency,
      openFlags: flagCounts.find((f) => f.invoiceId === i.id)?.n ?? 0,
    })),
    timeline: events.map((e) => toTimelineEvent(e, people)),
    allowedActions: {
      approve: allowed("vendor.approve", checkApprove(v, person)),
      hold: allowed("vendor.hold", checkHold(v, "reason given in the form")),
      releaseHold: allowed("vendor.release_hold", checkReleaseHold(v, "reason given in the form")),
      requestBankChange: allowed("vendor.bank_change.request", pending ? [{ status: 409, code: "CHANGE_ALREADY_PENDING", message: "A bank change is already waiting for verification; verify or reject it first." }] : []),
      verifyBankChange: allowed("vendor.bank_change.verify", checkBankDecision(pending, person, "verify")),
      rejectBankChange: allowed("vendor.bank_change.verify", checkBankDecision(pending, person, "reject", "reason given in the form")),
    },
  };
}

