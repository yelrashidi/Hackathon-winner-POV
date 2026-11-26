import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import type { Actor } from "@/contracts/actor";
import { AuditInvoiceListQuery, type AuditInvoiceList, type AuditInvoiceListQuery as Query, type InvoiceSort } from "@/contracts/audit-view";
import { getDb, type Db } from "@/server/db/client";
import { invoices, vendors } from "@/server/db/schema";
import { guard, iso, loadPeople } from "./shared";

/**
 * Screen 1 of the auditor dashboard: every invoice (history and new), newest first unless the
 * query asks for another `sort`, with what an
 * auditor scans for — flag counts, overrides, who gave the final approval, payment and releaser.
 * Each row links to getInvoiceAuditDetail(row.invoiceId). Auditor only.
 */
export async function listAuditInvoices(actor: Actor, query: Query = {}, opts: { db?: Db } = {}): Promise<AuditInvoiceList> {
  const db = opts.db ?? getDb();
  await guard(actor, "audit.view", db);
  return queryInvoiceList(db, query);
}

/** The vendor name a row shows (and sorts by): the vendor master's legal name, else the name on the bill. */
const vendorNameSql = sql<string | null>`coalesce(${vendors.legalName}, ${invoices.vendorNameRaw})`;

/**
 * ORDER BY for each sort. Vendor sorts are case-insensitive, put bills with no vendor name last, and
 * show each vendor's newest bill first. Every order ends on the id so pages are stable.
 */
function orderFor(sort: InvoiceSort = "newest"): SQL[] {
  const vendorKey = sql`lower(${vendorNameSql})`;
  switch (sort) {
    case "oldest":
      return [asc(invoices.invoiceDate), asc(invoices.id)];
    case "vendor_az":
      return [sql`${vendorKey} ASC NULLS LAST`, desc(invoices.invoiceDate), desc(invoices.id)];
    case "vendor_za":
      return [sql`${vendorKey} DESC NULLS LAST`, desc(invoices.invoiceDate), desc(invoices.id)];
    case "newest":
      return [desc(invoices.invoiceDate), desc(invoices.id)];
  }
}

/** Limits a list to one department's invoices, or to one person's own requests (features/invoices). */
export interface InvoiceListScope {
  departmentId?: string;
  requesterId?: string;
}

/**
 * The list query itself, with NO permission check — callers authorize first (listAuditInvoices for
 * the audit trail, features/invoices for the role-scoped invoice records).
 */
export async function queryInvoiceList(db: Db, query: Query = {}, scope: InvoiceListScope = {}): Promise<AuditInvoiceList> {
  const q = AuditInvoiceListQuery.parse(query);

  const flagCount = (cond: string) =>
    sql<number>`(SELECT count(*)::int FROM invoice_flags f WHERE f.invoice_id = ${invoices.id} AND ${sql.raw(cond)})`.mapWith(Number);
  const overrides = flagCount("f.status = 'overridden'");
  const openBlocking = flagCount("f.status = 'open' AND f.severity = 'block'");

  const where: (SQL | undefined)[] = [
    q.search ? or(ilike(invoices.id, `%${q.search}%`), ilike(invoices.invoiceNumber, `%${q.search}%`), ilike(vendors.legalName, `%${q.search}%`), ilike(invoices.vendorNameRaw, `%${q.search}%`)) : undefined,
    q.status ? eq(invoices.status, q.status) : undefined,
    q.statuses?.length ? inArray(invoices.status, q.statuses) : undefined,
    q.vendorId ? eq(invoices.vendorId, q.vendorId) : undefined,
    q.from ? gte(invoices.invoiceDate, q.from) : undefined,
    q.to ? lte(invoices.invoiceDate, q.to) : undefined,
    q.hasOverrides ? sql`${overrides} > 0` : undefined,
    q.hasOpenBlocking ? sql`${openBlocking} > 0` : undefined,
    scope.departmentId ? eq(invoices.departmentId, scope.departmentId) : undefined,
    scope.requesterId ? eq(invoices.requesterId, scope.requesterId) : undefined,
  ];
  const filter = and(...where);

  const [rows, [countRow], people] = await Promise.all([
    db
      .select({
        invoiceId: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        vendorId: invoices.vendorId,
        vendorName: vendorNameSql,
        invoiceDate: invoices.invoiceDate,
        receivedDate: invoices.receivedDate,
        currency: invoices.currency,
        totalCents: invoices.totalCents,
        totalCadCents: invoices.totalCadCents,
        status: invoices.status,
        source: invoices.source,
        open: flagCount("f.status = 'open'"),
        openBlocking,
        resolved: flagCount("f.status = 'resolved'"),
        overridden: overrides,
        approverId: sql<string | null>`(SELECT s.acted_by FROM approval_steps s WHERE s.invoice_id = ${invoices.id} AND s.decision = 'approved' ORDER BY s.decided_at DESC NULLS LAST, s.seq DESC LIMIT 1)`,
        approvedAt: sql<string | null>`(SELECT s.decided_at::text FROM approval_steps s WHERE s.invoice_id = ${invoices.id} AND s.decision = 'approved' ORDER BY s.decided_at DESC NULLS LAST, s.seq DESC LIMIT 1)`,
        payment: sql<string | null>`(SELECT json_build_object('status', p.status, 'paidDate', p.paid_date, 'releasedBy', p.released_by, 'amountCents', p.amount_cents)::text
                                     FROM payments p WHERE p.invoice_id = ${invoices.id} ORDER BY p.paid_date DESC NULLS FIRST, p.id DESC LIMIT 1)`,
        lastActivityAt: sql<string | null>`(SELECT max(e.occurred_at)::text FROM audit_events e WHERE e.invoice_id = ${invoices.id})`,
        eventCount: sql<number>`(SELECT count(*)::int FROM audit_events e WHERE e.invoice_id = ${invoices.id})`.mapWith(Number),
      })
      .from(invoices)
      .leftJoin(vendors, eq(vendors.id, invoices.vendorId))
      .where(filter)
      .orderBy(...orderFor(q.sort))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ n: sql<number>`count(*)::int`.mapWith(Number) }).from(invoices).leftJoin(vendors, eq(vendors.id, invoices.vendorId)).where(filter),
    loadPeople(db),
  ]);

  return {
    total: countRow?.n ?? 0,
    page: q.page,
    pageSize: q.pageSize,
    rows: rows.map((r) => {
      const pay = r.payment ? (JSON.parse(r.payment) as { status: string; paidDate: string | null; releasedBy: string | null; amountCents: number | string }) : null;
      return {
        invoiceId: r.invoiceId,
        invoiceNumber: r.invoiceNumber,
        vendorId: r.vendorId,
        vendorName: r.vendorName,
        invoiceDate: r.invoiceDate,
        receivedDate: r.receivedDate,
        currency: r.currency,
        totalCents: r.totalCents,
        totalCadCents: r.totalCadCents,
        status: r.status,
        source: r.source,
        flags: { open: r.open, openBlocking: r.openBlocking, resolved: r.resolved, overridden: r.overridden },
        finalApprover: r.approverId ? { person: people(r.approverId)!, at: iso(r.approvedAt) } : null,
        payment: pay ? { status: pay.status, paidDate: pay.paidDate, releasedBy: people(pay.releasedBy), amountCents: Number(pay.amountCents) } : null,
        lastActivityAt: iso(r.lastActivityAt),
        eventCount: r.eventCount,
      };
    }),
  };
}
