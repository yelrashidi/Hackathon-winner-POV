import { asc, eq, inArray, sql } from "drizzle-orm";
import type { Actor } from "@/contracts/actor";
import type { ApprovalPlan } from "@/contracts/approvals";
import { can } from "@/server/core/authorize";
import { documents, invoiceFlags, invoices, vendors } from "@/server/db/schema";
import { checkDecision, currentStep, getApprovalPlans, getCurrentApprovalPlan, waitingOn, type InvoiceRef } from "@/server/features/approvals";
import { invoiceCoding, loadApprovalContext, PostgresApprovalStore } from "@/server/pipeline";
import { allow, dbOf, departmentNames, people, type Opts, type PersonRef } from "./shared";

/**
 * Approvals (feature 6) for the people who sign: managers, the Finance Manager and the Admin.
 * Who must act is ALWAYS approvals' own answer — waitingOn() re-resolves delegation (on leave →
 * delegate), escalation and separation of duties at read time, exactly as checkDecision() will
 * when they click. The UI never decides who may approve.
 */

export interface ApprovalRow {
  invoiceId: string;
  vendorName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  currency: string | null;
  totalCents: number | null;
  totalCadCents: number | null;
  departmentName: string | null;
  requester: PersonRef | null;
  step: { seq: number; of: number; role: string; reason: string };
  waitingOn: PersonRef | null;
  onBehalfOf: PersonRef | null;
  waitingSince: string;
  attention: number;
  mine: boolean;
}

const ROLE_LABEL: Record<string, string> = { dept_manager: "Department manager", finance_manager: "Finance Manager", controller_admin: "Controller", cfo: "CFO" };
export const stepRoleLabel = (role: string) => ROLE_LABEL[role] ?? role;

export async function listApprovals(actor: Actor, opts: Opts = {}): Promise<ApprovalRow[]> {
  allow(actor, "approval.decide");
  const db = dbOf(opts);
  const now = new Date();
  const [rows, who, depts, ctx] = await Promise.all([
    db
      .select({ inv: invoices, vendorName: sql<string | null>`coalesce(${vendors.legalName}, ${invoices.vendorNameRaw})` })
      .from(invoices)
      .leftJoin(vendors, eq(vendors.id, invoices.vendorId))
      .where(eq(invoices.status, "PendingApproval"))
      .orderBy(asc(invoices.dueDate)),
    people(db),
    departmentNames(db),
    loadApprovalContext(db, now),
  ]);
  const store = new PostgresApprovalStore(db);
  const out: ApprovalRow[] = [];
  for (const { inv, vendorName } of rows) {
    const plan = await getCurrentApprovalPlan(inv.id, { invoiceVersion: inv.version, store });
    if (!plan) continue;
    const step = currentStep(plan);
    if (!step) continue;
    const res = waitingOn(plan, { requesterId: inv.requesterId ?? "", submittedBy: null }, ctx);
    const previous = plan.steps.filter((s) => s.seq < step.seq && s.decidedAt).map((s) => s.decidedAt!).sort().at(-1);
    out.push({
      invoiceId: inv.id,
      vendorName,
      invoiceNumber: inv.invoiceNumber,
      invoiceDate: inv.invoiceDate,
      dueDate: inv.dueDate,
      currency: inv.currency,
      totalCents: inv.totalCents,
      totalCadCents: inv.totalCadCents,
      departmentName: inv.departmentId ? (depts.get(inv.departmentId) ?? inv.departmentId) : null,
      requester: who(inv.requesterId),
      step: { seq: step.seq, of: plan.steps.length, role: step.role, reason: step.reasons[0]?.message ?? "" },
      waitingOn: who(res?.assignee),
      onBehalfOf: who(res?.onBehalfOf),
      waitingSince: previous ?? plan.routedAt,
      attention: plan.attention.length,
      mine: res?.assignee === actor.userId,
    });
  }
  return out;
}

export interface ApprovalDetail {
  invoice: {
    invoiceId: string;
    status: string;
    version: number;
    vendorId: string | null;
    vendorName: string | null;
    vendorStatus: string | null;
    invoiceNumber: string | null;
    invoiceDate: string | null;
    dueDate: string | null;
    currency: string | null;
    subtotalCents: number | null;
    totalCents: number | null;
    totalCadCents: number | null;
    fxRate: string | null;
    isCreditNote: boolean;
    poId: string | null;
    departmentName: string | null;
    requester: PersonRef | null;
  };
  document: { documentId: string; fileName: string | null } | null;
  plan: ApprovalPlan | null;
  history: ApprovalPlan[];
  lines: Awaited<ReturnType<typeof invoiceCoding>>["lines"];
  journal: Awaited<ReturnType<typeof invoiceCoding>>["journal"];
  flags: { code: string; severity: string; message: string; status: string; note: string | null; resolvedBy: PersonRef | null }[];
  /** Whether the signed-in person may act on the current step now, and if not, the reason approvals gives. */
  you: { canAct: true; onBehalfOf: PersonRef | null } | { canAct: false; reason: string } | null;
  waitingOn: PersonRef | null;
  names: Record<string, PersonRef>;
}

export async function getApproval(actor: Actor, invoiceId: string, opts: Opts = {}): Promise<ApprovalDetail | null> {
  // Anyone who approves may read an invoice's approval page; so may the review roles (it links from Checks).
  allow(actor, "approval.decide", "invoice.review");
  const db = dbOf(opts);
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!inv) return null;
  const store = new PostgresApprovalStore(db);
  const [vendor, doc, who, depts, history, coding, flags, ctx] = await Promise.all([
    inv.vendorId ? db.select().from(vendors).where(eq(vendors.id, inv.vendorId)).then((r) => r[0] ?? null) : Promise.resolve(null),
    inv.documentId ? db.select().from(documents).where(eq(documents.id, inv.documentId)).then((r) => r[0] ?? null) : Promise.resolve(null),
    people(db),
    departmentNames(db),
    getApprovalPlans(invoiceId, { store }),
    invoiceCoding(db, invoiceId),
    db.select().from(invoiceFlags).where(eq(invoiceFlags.invoiceId, invoiceId)).orderBy(asc(invoiceFlags.id)),
    loadApprovalContext(db, new Date()),
  ]);
  const plan = (await getCurrentApprovalPlan(invoiceId, { invoiceVersion: inv.version, store })) ?? history.at(-1) ?? null;

  const ref: InvoiceRef = { invoiceId, invoiceVersion: inv.version, status: inv.status, requesterId: inv.requesterId ?? "", submittedBy: null, vendorId: inv.vendorId };
  let you: ApprovalDetail["you"] = null;
  let waiting: PersonRef | null = null;
  if (plan && inv.status === "PendingApproval") {
    const res = waitingOn(plan, ref, ctx);
    waiting = who(res?.assignee);
    if (can(actor, "approval.decide")) {
      const check = checkDecision(plan, ref, actor.userId, { action: "approve", acknowledgedFlags: plan.attention.map((a) => a.code) }, ctx);
      you = check.ok ? { canAct: true, onBehalfOf: who(check.onBehalfOf) } : { canAct: false, reason: check.reason };
    }
  }

  const names: Record<string, PersonRef> = {};
  for (const p of history) {
    for (const s of p.steps) for (const id of [s.assignedTo, s.routedTo, s.onBehalfOf, s.actedBy]) if (id && who(id)) names[id] = who(id)!;
    for (const e of p.excludedApprovers) if (who(e.userId)) names[e.userId] = who(e.userId)!;
  }
  for (const l of coding.lines) if (l.codedBy && who(l.codedBy)) names[l.codedBy] = who(l.codedBy)!;

  return {
    invoice: {
      invoiceId: inv.id,
      status: inv.status,
      version: inv.version,
      vendorId: inv.vendorId,
      vendorName: vendor?.legalName ?? inv.vendorNameRaw,
      vendorStatus: vendor?.status ?? null,
      invoiceNumber: inv.invoiceNumber,
      invoiceDate: inv.invoiceDate,
      dueDate: inv.dueDate,
      currency: inv.currency,
      subtotalCents: inv.subtotalCents,
      totalCents: inv.totalCents,
      totalCadCents: inv.totalCadCents,
      fxRate: inv.fxRate,
      isCreditNote: inv.isCreditNote,
      poId: inv.poId,
      departmentName: inv.departmentId ? (depts.get(inv.departmentId) ?? inv.departmentId) : null,
      requester: who(inv.requesterId),
    },
    document: doc ? { documentId: doc.id, fileName: doc.fileName } : null,
    plan,
    history,
    lines: coding.lines,
    journal: coding.journal,
    flags: flags.map((f) => ({ code: f.code, severity: f.severity, message: f.message, status: f.status, note: f.resolutionNote, resolvedBy: who(f.resolvedBy) })),
    you,
    waitingOn: waiting,
    names,
  };
}

/** Recently decided by this person (for the "Done" tab). */
export async function recentDecisions(actor: Actor, opts: Opts = {}) {
  allow(actor, "approval.decide");
  const db = dbOf(opts);
  const rows = await db.execute<{ invoice_id: string; decision: string; decided_at: string; on_behalf_of: string | null; comment: string | null; seq: number; role: string }>(sql`
    SELECT s.invoice_id, s.decision, s.decided_at::text, s.on_behalf_of, s.comment, s.seq, s.role
    FROM approval_steps s
    WHERE s.acted_by = ${actor.userId} AND s.decided_at IS NOT NULL
    ORDER BY s.decided_at DESC LIMIT 25`);
  const list = (Array.isArray(rows) ? rows : (rows as { rows: unknown[] }).rows) as { invoice_id: string; decision: string; decided_at: string; on_behalf_of: string | null; comment: string | null; seq: number; role: string }[];
  if (list.length === 0) return [];
  const [who, invs] = await Promise.all([
    people(db),
    db
      .select({ id: invoices.id, status: invoices.status, vendorName: sql<string | null>`coalesce(${vendors.legalName}, ${invoices.vendorNameRaw})`, totalCents: invoices.totalCents, currency: invoices.currency })
      .from(invoices)
      .leftJoin(vendors, eq(vendors.id, invoices.vendorId))
      .where(inArray(invoices.id, list.map((r) => r.invoice_id))),
  ]);
  const byId = new Map(invs.map((i) => [i.id, i]));
  return list.map((r) => ({
    invoiceId: r.invoice_id,
    decision: r.decision,
    decidedAt: new Date(r.decided_at).toISOString(),
    onBehalfOf: who(r.on_behalf_of),
    comment: r.comment,
    step: r.seq,
    role: r.role,
    invoice: byId.get(r.invoice_id) ?? null,
  }));
}
