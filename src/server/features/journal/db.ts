import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Actor } from "@/contracts/actor";
import { recordDenied, withAction } from "@/server/core/audit";
import { authorize, Forbidden } from "@/server/core/authorize";
import { getDb, type Db, type Executor } from "@/server/db/client";
import { auditEvents, glAccounts, invoiceLines, invoiceTaxes, invoices, payments, users, vendors } from "@/server/db/schema";
import { csvCell } from "@/server/features/audit";
import { buildJournal } from "@/server/features/coding";
import { loadCodingContext } from "@/server/pipeline";
import { billEntry, journalCsv, paymentEntry, type Excluded, type JournalEntryOut } from "./build";
import { JOURNAL_ACCOUNTS, POSTED_BILL_STATUSES } from "./config";

/**
 * The journal export on the database (authorize "journal.export": Finance Manager, Controller/Admin).
 *
 *   previewJournal(actor, query)   what would be exported: entries, totals, what is left out and why
 *   exportJournal(actor, query)    the same as a CSV, and ONE audit event recording who exported
 *                                  which bills and payments — so the next "only new" export skips them
 *   journalExports(actor)          the export history (who, when, which period, how many)
 *
 * Bills: approved, scheduled or paid invoices, dated their invoice date. Payments: SETTLED only
 * (the bank confirmed the money left), dated the paid date — a released transfer can still fail,
 * and posting only settled payments means nothing ever has to be reversed.
 */

export interface JournalQuery {
  /** Entry date range (YYYY-MM-DD, inclusive). Omitted = no limit. */
  from?: string;
  to?: string;
  bills?: boolean;
  payments?: boolean;
  /** Leave out bills and payments an earlier export already contained (default true). */
  onlyNew?: boolean;
}

export interface JournalPreview {
  query: Required<Pick<JournalQuery, "bills" | "payments" | "onlyNew">> & Pick<JournalQuery, "from" | "to">;
  entries: JournalEntryOut[];
  excluded: Excluded[];
  /** Entries left out because an earlier export already had them (onlyNew). */
  alreadyExported: number;
  totals: { bills: number; payments: number; lines: number; debitCents: number; creditCents: number; balanced: boolean };
  accounts: typeof JOURNAL_ACCOUNTS;
}

export interface JournalExportRecord {
  exportId: string;
  at: string;
  by: { userId: string; name: string };
  from: string | null;
  to: string | null;
  bills: number;
  payments: number;
  debitCents: number;
}

type Opts = { db?: Db };

async function allow(actor: Actor, db: Db) {
  try {
    return authorize(actor, "journal.export").actor;
  } catch (err) {
    if (err instanceof Forbidden) await recordDenied(actor, { attempted: "journal.export", reason: err.reason, entityType: "journal_export", entityId: "-" }, { db });
    throw err;
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) out.set(key(r), [...(out.get(key(r)) ?? []), r]);
  return out;
}
const iso = (v: string | Date | null) => (v === null ? null : new Date(v).toISOString());

function normalise(q: JournalQuery): JournalPreview["query"] {
  return {
    from: q.from && DAY.test(q.from) ? q.from : undefined,
    to: q.to && DAY.test(q.to) ? q.to : undefined,
    bills: q.bills ?? true,
    payments: q.payments ?? true,
    onlyNew: q.onlyNew ?? true,
  };
}

/** Ids every earlier export already contained. */
async function exportedBefore(db: Executor): Promise<{ bills: Set<string>; payments: Set<string> }> {
  const rows = await db.select({ metadata: auditEvents.metadata }).from(auditEvents).where(eq(auditEvents.action, "journal.exported"));
  const bills = new Set<string>();
  const pays = new Set<string>();
  for (const r of rows) {
    const m = (r.metadata ?? {}) as { billIds?: string[]; paymentIds?: string[] };
    for (const id of m.billIds ?? []) bills.add(id);
    for (const id of m.paymentIds ?? []) pays.add(id);
  }
  return { bills, payments: pays };
}

async function build(db: Executor, q: JournalPreview["query"]): Promise<JournalPreview> {
  const [accounts, done] = await Promise.all([db.select({ n: glAccounts.accountNumber, name: glAccounts.name }).from(glAccounts), exportedBefore(db)]);
  const names = new Map(accounts.map((a) => [a.n, a.name]));
  const extra = new Map(Object.values(JOURNAL_ACCOUNTS).map((a) => [a.code, a.name]));
  const accountName = (code: string) => names.get(code) ?? extra.get(code) ?? code;
  const entries: JournalEntryOut[] = [];
  const excluded: Excluded[] = [];
  let alreadyExported = 0;
  const ctx = await loadCodingContext(db);

  if (q.bills) {
    const conds = [inArray(invoices.status, POSTED_BILL_STATUSES), isNotNull(invoices.invoiceDate), isNotNull(invoices.totalCents)];
    if (q.from) conds.push(sql`${invoices.invoiceDate} >= ${q.from}`);
    if (q.to) conds.push(sql`${invoices.invoiceDate} <= ${q.to}`);
    const bills = await db
      .select({ inv: invoices, vendorName: sql<string>`coalesce(${vendors.legalName}, ${invoices.vendorNameRaw}, 'Unknown vendor')` })
      .from(invoices)
      .leftJoin(vendors, eq(vendors.id, invoices.vendorId))
      .where(and(...conds))
      .orderBy(asc(invoices.invoiceDate), asc(invoices.id));
    const ids = bills.map((b) => b.inv.id);
    const [lines, taxes] = ids.length
      ? await Promise.all([
          db.select().from(invoiceLines).where(inArray(invoiceLines.invoiceId, ids)).orderBy(asc(invoiceLines.lineNo)),
          db.select().from(invoiceTaxes).where(inArray(invoiceTaxes.invoiceId, ids)).orderBy(asc(invoiceTaxes.id)),
        ])
      : [[], []];
    const linesBy = groupBy(lines, (l) => l.invoiceId);
    const taxesBy = groupBy(taxes, (t) => t.invoiceId);
    for (const { inv, vendorName } of bills) {
      if (q.onlyNew && done.bills.has(inv.id)) {
        alreadyExported++;
        continue;
      }
      const ls = linesBy.get(inv.id) ?? [];
      const journal = buildJournal(
        {
          currency: inv.currency,
          totalCents: inv.totalCents,
          taxes: (taxesBy.get(inv.id) ?? []).map((t) => ({ code: t.taxCode, label: t.label ?? t.taxCode ?? "", ratePct: null, amountCents: t.amountCents })),
        },
        ls.map((l) => ({ lineNo: l.lineNo, amountCents: l.amountCents, lineType: l.lineType === "goods" || l.lineType === "services" ? l.lineType : null, glAccount: l.glAccountCode, departmentId: l.departmentId })),
        ctx,
      ).journal;
      const r = billEntry(
        {
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          invoiceDate: inv.invoiceDate!,
          vendorId: inv.vendorId,
          vendorName,
          currency: inv.currency ?? "CAD",
          fxRate: inv.fxRate ?? "1",
          totalCents: inv.totalCents!,
          totalCadCents: inv.totalCadCents,
          lineDescriptions: new Map(ls.map((l) => [l.lineNo, l.description])),
        },
        journal,
        accountName,
      );
      if (r.ok) entries.push(r.entry);
      else excluded.push(r.excluded);
    }
  }

  if (q.payments) {
    const paidDate = sql<string>`coalesce(${payments.paidDate}, (${payments.settledAt} at time zone 'America/Toronto')::date)::text`;
    const conds = [eq(payments.status, "settled")];
    if (q.from) conds.push(sql`${paidDate} >= ${q.from}`);
    if (q.to) conds.push(sql`${paidDate} <= ${q.to}`);
    const rows = await db
      .select({
        p: payments,
        paidDate,
        invoiceNumber: invoices.invoiceNumber,
        invoiceFxRate: invoices.fxRate,
        vendorId: invoices.vendorId,
        vendorName: sql<string>`coalesce(${vendors.legalName}, ${invoices.vendorNameRaw}, 'Unknown vendor')`,
      })
      .from(payments)
      .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
      .leftJoin(vendors, eq(vendors.id, invoices.vendorId))
      .where(and(...conds))
      .orderBy(asc(paidDate), asc(payments.id));
    for (const r of rows) {
      if (q.onlyNew && done.payments.has(r.p.id)) {
        alreadyExported++;
        continue;
      }
      const built = paymentEntry(
        {
          paymentId: r.p.id,
          invoiceId: r.p.invoiceId,
          invoiceNumber: r.invoiceNumber,
          vendorId: r.vendorId,
          vendorName: r.vendorName,
          method: r.p.method,
          paidDate: r.paidDate,
          reference: r.p.reference,
          currency: r.p.currency,
          amountCents: r.p.amountCents,
          amountCadCents: r.p.amountCadCents,
          discountTakenCents: r.p.discountTakenCents,
          fxRate: r.p.fxRate ?? "1",
          invoiceFxRate: r.invoiceFxRate,
        },
        ctx.apControlAccount,
        accountName,
      );
      if (built.ok) entries.push(built.entry);
      else excluded.push(built.excluded);
    }
  }

  entries.sort((a, b) => a.entryDate.localeCompare(b.entryDate) || (a.entryType === b.entryType ? a.entryId.localeCompare(b.entryId) : a.entryType === "bill" ? -1 : 1));
  const debitCents = entries.reduce((s, e) => s + e.debitCents, 0);
  const creditCents = entries.reduce((s, e) => s + e.creditCents, 0);
  return {
    query: q,
    entries,
    excluded,
    alreadyExported,
    totals: {
      bills: entries.filter((e) => e.entryType === "bill").length,
      payments: entries.filter((e) => e.entryType === "payment").length,
      lines: entries.reduce((s, e) => s + e.lines.length, 0),
      debitCents,
      creditCents,
      balanced: debitCents === creditCents && entries.every((e) => e.debitCents === e.creditCents),
    },
    accounts: JOURNAL_ACCOUNTS,
  };
}

export async function previewJournal(actor: Actor, query: JournalQuery = {}, opts: Opts = {}): Promise<JournalPreview> {
  const db = opts.db ?? getDb();
  await allow(actor, db);
  return build(db, normalise(query));
}

export class JournalExportError extends Error {
  readonly status = 409 as const;
  constructor(message: string) {
    super(message);
    this.name = "JournalExportError";
  }
}

/**
 * The CSV plus one `journal.exported` audit event (in the same transaction as the read, so two
 * people exporting at once cannot both get the same "new" entries).
 */
export async function exportJournal(actor: Actor, query: JournalQuery = {}, opts: Opts = {}): Promise<{ csv: string; fileName: string; preview: JournalPreview; exportId: string }> {
  const db = opts.db ?? getDb();
  const who = await allow(actor, db);
  const q = normalise(query);
  return withAction(
    who,
    async (action) => {
      // Serialise exports: the second waits for the first, then sees its ids as already exported.
      await action.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('journal.export'))`);
      const preview = await build(action.tx, q);
      if (preview.entries.length === 0) throw new JournalExportError("Nothing to export for this selection.");
      if (!preview.totals.balanced) throw new JournalExportError("The selection does not balance; nothing was exported.");
      const exportId = `JX-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomUUID().slice(0, 6).toUpperCase()}`;
      await action.audit({
        action: "journal.exported",
        entityType: "journal_export",
        entityId: exportId,
        after: {
          from: q.from ?? null,
          to: q.to ?? null,
          bills: preview.totals.bills,
          payments: preview.totals.payments,
          lines: preview.totals.lines,
          debitCents: preview.totals.debitCents,
          creditCents: preview.totals.creditCents,
          excluded: preview.excluded.length,
        },
        metadata: {
          onlyNew: q.onlyNew,
          billIds: preview.entries.filter((e) => e.entryType === "bill").map((e) => e.invoiceId),
          paymentIds: preview.entries.filter((e) => e.entryType === "payment").map((e) => e.paymentId!),
        },
      });
      const fileName = `harborline-journal-${q.from ?? "start"}-to-${q.to ?? "now"}-${exportId}.csv`;
      return { csv: journalCsv(preview.entries, csvCell), fileName, preview, exportId };
    },
    { db },
  );
}

export async function journalExports(actor: Actor, opts: Opts & { limit?: number } = {}): Promise<JournalExportRecord[]> {
  const db = opts.db ?? getDb();
  await allow(actor, db);
  const rows = await db
    .select({ e: auditEvents, name: users.fullName })
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.actorId))
    .where(eq(auditEvents.action, "journal.exported"))
    .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
    .limit(opts.limit ?? 10);
  return rows.map(({ e, name }) => {
    const a = (e.after ?? {}) as { from?: string | null; to?: string | null; bills?: number; payments?: number; debitCents?: number };
    return {
      exportId: e.entityId,
      at: iso(e.occurredAt)!,
      by: { userId: e.actorId, name: name ?? e.actorId },
      from: a.from ?? null,
      to: a.to ?? null,
      bills: a.bills ?? 0,
      payments: a.payments ?? 0,
      debitCents: a.debitCents ?? 0,
    };
  });
}
