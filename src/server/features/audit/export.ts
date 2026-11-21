import { and, asc, eq, gte, lt, or, sql } from "drizzle-orm";
import type { Actor } from "@/contracts/actor";
import { getDb, type Db } from "@/server/db/client";
import { auditEvents, invoices, users, vendors } from "@/server/db/schema";
import { guard, iso } from "./shared";

/**
 * Auditor export: the audit log as CSV, one row per event, for a date range and/or one invoice.
 * Before/after are kept as JSON text so nothing is lost in the flattening. Auditor only.
 */
export const AUDIT_CSV_COLUMNS = [
  "event_id",
  "occurred_at",
  "action",
  "actor_id",
  "actor_name",
  "actor_role_at_time",
  "on_behalf_of_id",
  "on_behalf_of_name",
  "entity_type",
  "entity_id",
  "invoice_id",
  "invoice_number",
  "vendor",
  "payment_id",
  "reason",
  "before_json",
  "after_json",
  "imported",
  "request_id",
] as const;

/** RFC 4180: quote when needed, double the quotes; neutralise spreadsheet formulas (=, +, -, @). */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface AuditExportQuery {
  /** Inclusive start date (YYYY-MM-DD), by occurred_at. */
  from?: string;
  /** Inclusive end date (YYYY-MM-DD). */
  to?: string;
  invoiceId?: string;
}

export async function exportAuditCsv(actor: Actor, query: AuditExportQuery = {}, opts: { db?: Db } = {}): Promise<{ csv: string; rows: number; fileName: string }> {
  const db = opts.db ?? getDb();
  await guard(actor, "audit.export", db, { invoiceId: query.invoiceId });

  const behalf = sql<string | null>`(SELECT u2.full_name FROM users u2 WHERE u2.id = ${auditEvents.onBehalfOf})`;
  const rows = await db
    .select({ e: auditEvents, actorName: users.fullName, invoiceNumber: invoices.invoiceNumber, vendor: sql<string | null>`coalesce(${vendors.legalName}, ${invoices.vendorNameRaw})`, behalfName: behalf })
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.actorId))
    .leftJoin(invoices, eq(invoices.id, auditEvents.invoiceId))
    .leftJoin(vendors, eq(vendors.id, invoices.vendorId))
    .where(
      and(
        query.from ? gte(auditEvents.occurredAt, `${query.from}T00:00:00Z`) : undefined,
        query.to ? lt(auditEvents.occurredAt, sql`(${query.to}::date + 1)::timestamptz`) : undefined,
        query.invoiceId ? or(eq(auditEvents.invoiceId, query.invoiceId), sql`${auditEvents.paymentId} IN (SELECT id FROM payments WHERE invoice_id = ${query.invoiceId})`) : undefined,
      ),
    )
    .orderBy(asc(auditEvents.occurredAt), asc(auditEvents.id));

  const lines = [AUDIT_CSV_COLUMNS.join(",")];
  for (const { e, actorName, invoiceNumber, vendor, behalfName } of rows) {
    lines.push(
      [
        e.id,
        iso(e.occurredAt),
        e.action,
        e.actorId,
        actorName,
        e.actorRole,
        e.onBehalfOf,
        behalfName,
        e.entityType,
        e.entityId,
        e.invoiceId,
        invoiceNumber,
        vendor,
        e.paymentId,
        e.reason,
        e.before,
        e.after,
        (e.metadata as Record<string, unknown> | null)?.imported === true ? "yes" : "no",
        e.requestId,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  const scope = query.invoiceId ?? [query.from ?? "start", query.to ?? "now"].join("_to_");
  return { csv: lines.join("\r\n") + "\r\n", rows: rows.length, fileName: `audit-log_${scope}.csv` };
}
