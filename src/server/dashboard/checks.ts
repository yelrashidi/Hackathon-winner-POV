import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Actor } from "@/contracts/actor";
import type { ApprovalPlan } from "@/contracts/approvals";
import type { JournalPreview, LineCoding } from "@/contracts/coding";
import { can } from "@/server/core/authorize";
import { approvalSteps, auditEvents, departments, documents, glAccounts, invoiceFlags, invoiceTaxes, invoices, purchaseOrders, taxCodes, vendors } from "@/server/db/schema";
import { getApprovalPlans } from "@/server/features/approvals";
import { invoiceCoding, PostgresApprovalStore, previewApproval } from "@/server/pipeline";
import { demoRoster } from "@/server/session/roster";
import { allow, dbOf, departmentNames, iso, people, type Opts, type PersonRef } from "./shared";

/**
 * "Checks": the invoices a person must look at before they can go to approval — the clerk's queue,
 * also open to managers, the Finance Manager and the Admin (authorize "invoice.review").
 *
 * Every incoming bill passes here: a person confirms every coded line (product.md feature 3), and
 * the queue puts first what the machine could NOT do — a bill nobody could read (manual entry),
 * an approval hold, a rejection, a blocking flag, a line coding is unsure about — and last the
 * ones where extraction and coding were confident ("Ready to confirm").
 */

export const CHECK_STATUSES = ["ManualEntry", "InReview", "OnHold"] as const;
/** Below this extraction confidence a field is marked "check this" (same as the upload screen). */
export const LOW_CONFIDENCE = 0.8;

export type CheckReasonKind = "unreadable" | "hold" | "rejected" | "blocking" | "coding" | "requester" | "extraction" | "warning" | "confirm" | "ready";

export interface CheckReason {
  kind: CheckReasonKind;
  label: string;
}

/** Most urgent first; the queue sorts on the first reason. */
const ORDER: CheckReasonKind[] = ["unreadable", "hold", "rejected", "blocking", "coding", "requester", "extraction", "warning", "confirm", "ready"];

export interface CheckRow {
  invoiceId: string;
  status: string;
  source: string;
  vendorId: string | null;
  vendorName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  receivedDate: string | null;
  dueDate: string | null;
  currency: string | null;
  totalCents: number | null;
  totalCadCents: number | null;
  departmentName: string | null;
  requester: PersonRef | null;
  flags: { block: number; warn: number; info: number };
  lines: { total: number; confirmed: number; unsure: number };
  reasons: CheckReason[];
}

function lowFields(confidence: unknown): string[] {
  if (!confidence || typeof confidence !== "object") return [];
  return Object.entries(confidence as Record<string, unknown>)
    .filter(([, v]) => typeof v === "number" && v < LOW_CONFIDENCE)
    .map(([k]) => k);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function listChecks(actor: Actor, opts: Opts = {}): Promise<CheckRow[]> {
  allow(actor, "invoice.review");
  const db = dbOf(opts);
  const count = (cond: string) => sql<number>`(SELECT count(*)::int FROM invoice_flags f WHERE f.invoice_id = ${invoices.id} AND f.status = 'open' AND ${sql.raw(cond)})`.mapWith(Number);
  const lineCount = (cond: string) => sql<number>`(SELECT count(*)::int FROM invoice_lines l WHERE l.invoice_id = ${invoices.id} AND ${sql.raw(cond)})`.mapWith(Number);
  const [rows, who, depts] = await Promise.all([
    db
      .select({
        inv: invoices,
        vendorName: sql<string | null>`coalesce(${vendors.legalName}, ${invoices.vendorNameRaw})`,
        // Coding's own block (CODING_NOT_CONFIRMED) is the line count below, not a "blocked" bill.
        block: count("f.severity = 'block' AND f.source <> 'coding'"),
        warn: count("f.severity = 'warn'"),
        info: count("f.severity = 'info'"),
        linesTotal: lineCount("true"),
        linesConfirmed: lineCount("l.coding_source IN ('accepted','changed')"),
        linesUnsure: lineCount("l.coding_source = 'suggested' AND coalesce(l.coding_reason->'account'->>'confidence', 'none') <> 'high'"),
        holdReasons: sql<unknown>`(SELECT p.hold_reasons FROM approval_plans p WHERE p.invoice_id = ${invoices.id} ORDER BY p.attempt DESC LIMIT 1)`,
        rejection: sql<string | null>`(SELECT json_build_object('by', s.acted_by, 'comment', s.comment)::text FROM approval_steps s WHERE s.invoice_id = ${invoices.id} AND s.decision = 'rejected' ORDER BY s.decided_at DESC NULLS LAST LIMIT 1)`,
        lastRoutedAt: sql<string | null>`(SELECT max(p.routed_at)::text FROM approval_plans p WHERE p.invoice_id = ${invoices.id})`,
        lastRejectedAt: sql<string | null>`(SELECT max(s.decided_at)::text FROM approval_steps s WHERE s.invoice_id = ${invoices.id} AND s.decision = 'rejected')`,
      })
      .from(invoices)
      .leftJoin(vendors, eq(vendors.id, invoices.vendorId))
      .where(inArray(invoices.status, [...CHECK_STATUSES])),
    people(db),
    departmentNames(db),
  ]);

  const out: CheckRow[] = rows.map((r) => {
    const i = r.inv;
    const reasons: CheckReason[] = [];
    if (i.status === "ManualEntry") reasons.push({ kind: "unreadable", label: "Couldn't be read automatically — type it in from the document" });
    if (i.status === "OnHold") {
      const holds = Array.isArray(r.holdReasons) ? (r.holdReasons as { message: string }[]) : [];
      reasons.push({ kind: "hold", label: holds.length ? `On hold: ${holds.map((h) => h.message).join(" · ")}` : "On hold" });
    }
    if (r.rejection && i.status === "InReview" && (r.lastRejectedAt ?? "") >= (r.lastRoutedAt ?? "")) {
      const rej = JSON.parse(r.rejection) as { by: string | null; comment: string | null };
      reasons.push({ kind: "rejected", label: `Rejected by ${who(rej.by)?.name ?? "an approver"}${rej.comment ? `: “${rej.comment}”` : ""}` });
    }
    if (r.block > 0) reasons.push({ kind: "blocking", label: `${plural(r.block, "blocking flag")} to resolve or override` });
    if (r.linesUnsure > 0) reasons.push({ kind: "coding", label: `Coding is unsure about ${plural(r.linesUnsure, "line")}` });
    if (i.status !== "ManualEntry" && !i.requesterId) reasons.push({ kind: "requester", label: "Set who asked for it (the requester) — approvals routes on it" });
    const low = i.status === "ManualEntry" ? [] : lowFields(i.extractionConfidence);
    if (low.length) reasons.push({ kind: "extraction", label: `${plural(low.length, "field")} read with low confidence: ${low.join(", ")}` });
    if (r.warn > 0) reasons.push({ kind: "warning", label: plural(r.warn, "warning") });
    const unconfirmed = r.linesTotal - r.linesConfirmed;
    if (i.status === "InReview" && r.block === 0 && i.requesterId && r.linesUnsure === 0 && unconfirmed > 0) reasons.push({ kind: "confirm", label: `Confident suggestions on ${plural(unconfirmed, "line")} — confirm and submit` });
    if (reasons.length === 0 || (reasons.every((x) => x.kind === "warning") && i.status === "InReview" && unconfirmed === 0 && i.requesterId)) {
      reasons.push({ kind: "ready", label: "Ready to submit for approval" });
    }
    reasons.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
    return {
      invoiceId: i.id,
      status: i.status,
      source: i.source,
      vendorId: i.vendorId,
      vendorName: r.vendorName,
      invoiceNumber: i.invoiceNumber,
      invoiceDate: i.invoiceDate,
      receivedDate: i.receivedDate,
      dueDate: i.dueDate,
      currency: i.currency,
      totalCents: i.totalCents,
      totalCadCents: i.totalCadCents,
      departmentName: i.departmentId ? (depts.get(i.departmentId) ?? i.departmentId) : null,
      requester: who(i.requesterId),
      flags: { block: r.block, warn: r.warn, info: r.info },
      lines: { total: r.linesTotal, confirmed: r.linesConfirmed, unsure: r.linesUnsure },
      reasons,
    };
  });
  return out.sort((a, b) => ORDER.indexOf(a.reasons[0]!.kind) - ORDER.indexOf(b.reasons[0]!.kind) || (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"));
}

// ---------------------------------------------------------------------------------------------
// One invoice: the review workbench
// ---------------------------------------------------------------------------------------------

export interface CheckFlag {
  id: number;
  source: string;
  code: string;
  severity: "block" | "warn" | "info";
  message: string;
  evidence: Record<string, unknown>;
  status: "open" | "resolved" | "overridden";
  resolvedBy: PersonRef | null;
  resolvedAt: string | null;
  note: string | null;
  relatedInvoiceId: string | null;
}

export interface CheckDetail {
  invoice: {
    invoiceId: string;
    status: string;
    version: number;
    source: string;
    vendorId: string | null;
    vendorNameRaw: string | null;
    invoiceNumber: string | null;
    invoiceDate: string | null;
    receivedDate: string | null;
    dueDate: string | null;
    currency: string | null;
    subtotalCents: number | null;
    totalCents: number | null;
    totalCadCents: number | null;
    fxRate: string | null;
    shipToProvince: string | null;
    isCreditNote: boolean;
    poId: string | null;
    poNumberRead: string | null;
    departmentId: string | null;
    requesterId: string | null;
  };
  vendor: { vendorId: string; legalName: string; status: string; category: string; requiresPo: boolean } | null;
  document: { documentId: string; fileName: string | null; mime: string | null } | null;
  provenance: { inboxMessageId: string | null; intakeReason: string | null; readBy: string | null; warnings: string[] };
  lowConfidence: string[];
  lines: (LineCoding & { glName: string | null; departmentName: string | null; codedByName: string | null })[];
  journal: JournalPreview | null;
  taxes: { code: string | null; label: string | null; rate: string | null; amountCents: number }[];
  flags: CheckFlag[];
  latestPlan: ApprovalPlan | null;
  preview: ApprovalPlan | null;
  rejection: { by: PersonRef | null; comment: string | null; at: string | null } | null;
  names: Record<string, PersonRef>;
}

export async function getCheck(actor: Actor, invoiceId: string, opts: Opts = {}): Promise<CheckDetail | null> {
  allow(actor, "invoice.review");
  const db = dbOf(opts);
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!inv) return null;

  const [vendor, doc, created, flagRows, taxRows, coding, gl, depts, who, rej] = await Promise.all([
    inv.vendorId ? db.select().from(vendors).where(eq(vendors.id, inv.vendorId)).then((r) => r[0] ?? null) : Promise.resolve(null),
    inv.documentId ? db.select().from(documents).where(eq(documents.id, inv.documentId)).then((r) => r[0] ?? null) : Promise.resolve(null),
    db.select({ metadata: auditEvents.metadata }).from(auditEvents).where(and(eq(auditEvents.invoiceId, invoiceId), eq(auditEvents.action, "invoice.created"))).limit(1),
    db.select().from(invoiceFlags).where(eq(invoiceFlags.invoiceId, invoiceId)).orderBy(asc(invoiceFlags.id)),
    db.select().from(invoiceTaxes).where(eq(invoiceTaxes.invoiceId, invoiceId)).orderBy(asc(invoiceTaxes.id)),
    invoiceCoding(db, invoiceId),
    db.select({ n: glAccounts.accountNumber, name: glAccounts.name }).from(glAccounts),
    departmentNames(db),
    people(db),
    db
      .select({ by: approvalSteps.actedBy, comment: approvalSteps.comment, at: approvalSteps.decidedAt })
      .from(approvalSteps)
      .where(and(eq(approvalSteps.invoiceId, invoiceId), eq(approvalSteps.decision, "rejected")))
      .orderBy(desc(approvalSteps.decidedAt))
      .limit(1),
  ]);
  const glName = new Map(gl.map((g) => [g.n, g.name]));
  const meta = (created[0]?.metadata ?? {}) as Record<string, unknown>;
  const raw = (inv.extractionRaw ?? {}) as Record<string, unknown>;

  const plans = await getApprovalPlans(invoiceId, { store: new PostgresApprovalStore(db) });
  const latestPlan = plans.at(-1) ?? null;
  const preview = inv.status === "InReview" ? await previewApproval(invoiceId, actor.userId, { db }).catch(() => null) : null;

  const names: Record<string, PersonRef> = {};
  const note = (id: string | null | undefined) => {
    const p = who(id);
    if (p) names[p.userId] = p;
  };
  for (const p of [latestPlan, preview]) {
    for (const s of p?.steps ?? []) [s.assignedTo, s.routedTo, s.onBehalfOf, s.actedBy].forEach(note);
    for (const e of p?.excludedApprovers ?? []) note(e.userId);
  }

  const rejectedAfterLastRoute = rej[0] && latestPlan && inv.status === "InReview" && (iso(rej[0].at) ?? "") >= latestPlan.routedAt;

  return {
    invoice: {
      invoiceId: inv.id,
      status: inv.status,
      version: inv.version,
      source: inv.source,
      vendorId: inv.vendorId,
      vendorNameRaw: inv.vendorNameRaw,
      invoiceNumber: inv.invoiceNumber,
      invoiceDate: inv.invoiceDate,
      receivedDate: inv.receivedDate,
      dueDate: inv.dueDate,
      currency: inv.currency,
      subtotalCents: inv.subtotalCents,
      totalCents: inv.totalCents,
      totalCadCents: inv.totalCadCents,
      fxRate: inv.fxRate,
      shipToProvince: inv.shipToProvince,
      isCreditNote: inv.isCreditNote,
      poId: inv.poId,
      poNumberRead: typeof raw.poNumber === "string" ? raw.poNumber : null,
      departmentId: inv.departmentId,
      requesterId: inv.requesterId,
    },
    vendor: vendor ? { vendorId: vendor.id, legalName: vendor.legalName, status: vendor.status, category: vendor.category, requiresPo: vendor.requiresPo } : null,
    document: doc ? { documentId: doc.id, fileName: doc.fileName, mime: doc.mime } : null,
    provenance: {
      inboxMessageId: typeof meta.inboxMessageId === "string" ? meta.inboxMessageId : null,
      intakeReason: typeof meta.intakeReason === "string" ? meta.intakeReason : null,
      readBy: typeof meta.readBy === "string" ? meta.readBy : null,
      warnings: Array.isArray(meta.warnings) ? (meta.warnings as string[]) : [],
    },
    lowConfidence: inv.status === "ManualEntry" ? [] : lowFields(inv.extractionConfidence),
    lines: coding.lines.map((l) => ({
      ...l,
      glName: l.glAccount ? (glName.get(l.glAccount) ?? null) : null,
      departmentName: l.departmentId ? (depts.get(l.departmentId) ?? null) : null,
      codedByName: who(l.codedBy)?.name ?? null,
    })),
    journal: coding.journal,
    taxes: taxRows.map((t) => ({ code: t.taxCode, label: t.label, rate: t.rate, amountCents: t.amountCents })),
    flags: flagRows.map((f) => ({
      id: f.id,
      source: f.source,
      code: f.code,
      severity: f.severity as CheckFlag["severity"],
      message: f.message,
      evidence: (f.evidence ?? {}) as Record<string, unknown>,
      status: f.status as CheckFlag["status"],
      resolvedBy: who(f.resolvedBy),
      resolvedAt: iso(f.resolvedAt),
      note: f.resolutionNote,
      relatedInvoiceId: f.relatedInvoiceId,
    })),
    latestPlan,
    preview,
    rejection: rejectedAfterLastRoute ? { by: who(rej[0]!.by), comment: rej[0]!.comment, at: iso(rej[0]!.at) } : null,
    names,
  };
}

// ---------------------------------------------------------------------------------------------
// The choices the review forms offer
// ---------------------------------------------------------------------------------------------

export interface ReviewOptions {
  departments: { value: string; label: string }[];
  /** Everyone active who can ask for a purchase, grouped by department in the UI. */
  people: { value: string; label: string; departmentId: string | null; role: string }[];
  accounts: { value: string; label: string; type: string }[];
  taxCodes: { value: string; label: string; ratePct: number }[];
  purchaseOrders: { value: string; label: string; vendorId: string }[];
}

export async function reviewOptions(actor: Actor, opts: Opts = {}): Promise<ReviewOptions> {
  allow(actor, "invoice.review");
  const db = dbOf(opts);
  const [d, cast, gl, tc, po] = await Promise.all([
    db.select().from(departments).orderBy(asc(departments.id)),
    demoRoster(db),
    db.select().from(glAccounts).orderBy(asc(glAccounts.accountNumber)),
    db.select().from(taxCodes).orderBy(asc(taxCodes.code)),
    db.select().from(purchaseOrders).where(sql`${purchaseOrders.status} <> 'closed'`).orderBy(asc(purchaseOrders.id)),
  ]);
  const deptName = new Map(d.map((x) => [x.id, x.name]));
  return {
    departments: d.map((x) => ({ value: x.id, label: x.name })),
    // Requesters: the demo cast only (one person per role), not the whole company.
    people: cast.map(({ user: x }) => ({ value: x.id, label: `${x.fullName} · ${x.title || x.role}${x.departmentId ? ` · ${deptName.get(x.departmentId) ?? x.departmentId}` : ""}`, departmentId: x.departmentId, role: x.role })),
    accounts: gl.filter((g) => g.accountType === "expense" || g.accountType === "asset").map((g) => ({ value: g.accountNumber, label: `${g.accountNumber} ${g.name}`, type: g.accountType })),
    taxCodes: tc.map((t) => ({ value: t.code, label: t.description, ratePct: Number(t.rate) * 100 })),
    purchaseOrders: po.map((p) => ({ value: p.id, label: `${p.id}${p.description ? ` · ${p.description}` : ""}`, vendorId: p.vendorId })),
  };
}

/** Whether this person may act on checks at all (for the home screen and the nav). */
export const canReview = (actor: Actor) => can(actor, "invoice.review");
