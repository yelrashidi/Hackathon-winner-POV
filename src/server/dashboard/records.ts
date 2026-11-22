import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Actor } from "@/contracts/actor";
import { can } from "@/server/core/authorize";
import { auditEvents, contracts, documents, inboxMessages, invoices, paymentFlags, purchaseOrders, vendorBankAccounts, vendors } from "@/server/db/schema";
import { allow, dbOf, iso, people, type Opts, type PersonRef } from "./shared";

// ---------------------------------------------------------------------------------------------
// Inbox (feature 1): every email intake saw, its verdict and reason, and the bills it produced
// ---------------------------------------------------------------------------------------------

export interface InboxRow {
  id: string;
  receivedAt: string;
  from: string | null;
  subject: string | null;
  decision: string;
  kind: string;
  reason: string | null;
  attachments: string[];
  invoices: { invoiceId: string; status: string }[];
}

export async function listInbox(actor: Actor, opts: Opts = {}): Promise<InboxRow[]> {
  allow(actor, "invoice.review");
  const db = dbOf(opts);
  const [msgs, linked] = await Promise.all([
    db.select().from(inboxMessages).orderBy(desc(inboxMessages.receivedAt)),
    db
      .select({ msg: documents.inboxMessageId, invoiceId: invoices.id, status: invoices.status })
      .from(invoices)
      .innerJoin(documents, eq(documents.id, invoices.documentId))
      .where(sql`${documents.inboxMessageId} IS NOT NULL`),
  ]);
  const byMsg = new Map<string, { invoiceId: string; status: string }[]>();
  for (const l of linked) byMsg.set(l.msg!, [...(byMsg.get(l.msg!) ?? []), { invoiceId: l.invoiceId, status: l.status }]);
  return msgs.map((m) => {
    const raw = (m.raw ?? {}) as { classification?: { reason?: string }; message?: { attachments?: { filename: string }[] }; attachments?: string[] };
    const [decision = "unclassified", kind = ""] = (m.classification ?? "unclassified").split("/");
    const attachments = raw.message?.attachments?.map((a) => a.filename) ?? (Array.isArray(raw.attachments) ? raw.attachments : []);
    return {
      id: m.id,
      receivedAt: iso(m.receivedAt)!,
      from: m.fromAddress,
      subject: m.subject,
      decision,
      kind,
      reason: raw.classification?.reason ?? null,
      attachments,
      invoices: byMsg.get(m.id) ?? [],
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Vendors (feature 9): the vendor master, bank details by version, what is open with each
// ---------------------------------------------------------------------------------------------

const canSeeVendors = (actor: Actor) => can(actor, "vendor.bank_change.request") || can(actor, "admin.edit");

export interface VendorRow {
  vendorId: string;
  legalName: string;
  category: string;
  status: string;
  province: string | null;
  requiresPo: boolean;
  paymentTermsDays: number | null;
  bank: { last4: string; version: number } | null;
  pendingBankChange: boolean;
  openInvoices: number;
  paidCadCents: number;
  openPaymentFlags: number;
}

export async function listVendors(actor: Actor, opts: Opts = {}): Promise<VendorRow[]> {
  if (!canSeeVendors(actor)) allow(actor, "vendor.bank_change.request");
  const db = dbOf(opts);
  const [vrows, banks, open, paid, flags] = await Promise.all([
    db.select().from(vendors).orderBy(asc(vendors.legalName)),
    db.select().from(vendorBankAccounts),
    db
      .select({ v: invoices.vendorId, n: sql<number>`count(*)::int` })
      .from(invoices)
      .where(inArray(invoices.status, ["ManualEntry", "InReview", "OnHold", "PendingApproval", "Approved", "PaymentScheduled"]))
      .groupBy(invoices.vendorId),
    db.select({ v: invoices.vendorId, n: sql<string>`coalesce(sum(${invoices.totalCadCents}), 0)::text` }).from(invoices).where(eq(invoices.status, "Paid")).groupBy(invoices.vendorId),
    db.select({ v: paymentFlags.vendorId, n: sql<number>`count(*)::int` }).from(paymentFlags).where(isNull(paymentFlags.clearedAt)).groupBy(paymentFlags.vendorId),
  ]);
  const count = (rows: { v: string | null; n: number | string }[]) => new Map(rows.map((r) => [r.v, Number(r.n)]));
  const [openBy, paidBy, flagsBy] = [count(open), count(paid), count(flags)];
  return vrows.map((v) => {
    const mine = banks.filter((b) => b.vendorId === v.id);
    const verified = mine.find((b) => b.status === "verified");
    return {
      vendorId: v.id,
      legalName: v.legalName,
      category: v.category,
      status: v.status,
      province: v.provinceOrState,
      requiresPo: v.requiresPo,
      paymentTermsDays: v.paymentTermsDays,
      bank: verified ? { last4: verified.last4, version: verified.version } : null,
      pendingBankChange: mine.some((b) => b.status === "pending"),
      openInvoices: openBy.get(v.id) ?? 0,
      paidCadCents: paidBy.get(v.id) ?? 0,
      openPaymentFlags: flagsBy.get(v.id) ?? 0,
    };
  });
}

export interface VendorDetail {
  vendor: typeof vendors.$inferSelect;
  bank: { version: number; status: string; last4: string; currency: string; changedAt: string | null; channel: string | null; requestedBy: PersonRef | null; verifiedBy: PersonRef | null; verifiedAt: string | null }[];
  contracts: (typeof contracts.$inferSelect)[];
  purchaseOrders: (typeof purchaseOrders.$inferSelect)[];
  invoices: { invoiceId: string; invoiceNumber: string | null; invoiceDate: string | null; status: string; currency: string | null; totalCents: number | null }[];
  history: { at: string; action: string; actor: PersonRef | null; reason: string | null; after: unknown }[];
}

export async function getVendor(actor: Actor, vendorId: string, opts: Opts = {}): Promise<VendorDetail | null> {
  if (!canSeeVendors(actor)) allow(actor, "vendor.bank_change.request");
  const db = dbOf(opts);
  const [v] = await db.select().from(vendors).where(eq(vendors.id, vendorId));
  if (!v) return null;
  const [bank, cs, pos, invs, who, hist] = await Promise.all([
    db.select().from(vendorBankAccounts).where(eq(vendorBankAccounts.vendorId, vendorId)).orderBy(desc(vendorBankAccounts.version)),
    db.select().from(contracts).where(eq(contracts.vendorId, vendorId)).orderBy(desc(contracts.startDate)),
    db.select().from(purchaseOrders).where(eq(purchaseOrders.vendorId, vendorId)).orderBy(desc(purchaseOrders.issueDate)),
    db
      .select({ invoiceId: invoices.id, invoiceNumber: invoices.invoiceNumber, invoiceDate: invoices.invoiceDate, status: invoices.status, currency: invoices.currency, totalCents: invoices.totalCents })
      .from(invoices)
      .where(eq(invoices.vendorId, vendorId))
      .orderBy(desc(invoices.invoiceDate))
      .limit(40),
    people(db),
    db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityType, "bank_account"), sql`${auditEvents.entityId} LIKE ${`${vendorId}#%`}`))
      .orderBy(desc(auditEvents.occurredAt)),
  ]);
  return {
    vendor: v,
    bank: bank.map((b) => ({ version: b.version, status: b.status, last4: b.last4, currency: b.currency, changedAt: b.changedAt, channel: b.channel, requestedBy: who(b.requestedBy), verifiedBy: who(b.verifiedBy), verifiedAt: iso(b.verifiedAt) })),
    contracts: cs,
    purchaseOrders: pos,
    invoices: invs,
    history: hist.map((h) => ({ at: iso(h.occurredAt)!, action: h.action, actor: who(h.actorId), reason: h.reason, after: h.after })),
  };
}

// ---------------------------------------------------------------------------------------------
// Recent activity (home screen): the latest audit events the person may read
// ---------------------------------------------------------------------------------------------

export async function recentActivity(actor: Actor, opts: Opts & { limit?: number } = {}) {
  allow(actor, "audit.view");
  const db = dbOf(opts);
  const [rows, who] = await Promise.all([
    db
      .select()
      .from(auditEvents)
      .where(sql`coalesce((${auditEvents.metadata}->>'imported')::boolean, false) = false AND ${auditEvents.actorRole} <> 'system'`)
      .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
      .limit(opts.limit ?? 8),
    people(db),
  ]);
  return rows.map((r) => ({ id: r.id, at: iso(r.occurredAt)!, action: r.action, actor: who(r.actorId), onBehalfOf: who(r.onBehalfOf), invoiceId: r.invoiceId, reason: r.reason }));
}
