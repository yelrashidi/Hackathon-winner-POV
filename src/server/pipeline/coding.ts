import { and, asc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { Actor } from "@/contracts/actor";
import type { AccountSuggestion, DepartmentSuggestion, LineCoding } from "@/contracts/coding";
import type { Flag } from "@/contracts/flag";
import type { ValidationInput } from "@/contracts/validation";
import { recordDenied, withAction, type ActionContext } from "@/server/core/audit";
import { authorize, Forbidden } from "@/server/core/authorize";
import { getDb, type Db, type Executor } from "@/server/db/client";
import { departments, glAccounts, invoiceLines, invoices, purchaseOrders, taxCodes, users, vendors } from "@/server/db/schema";
import {
  acceptConfident,
  buildJournal,
  codeLine,
  codingSubmitFlags,
  CodingIndex,
  suggestCoding,
  type CodedLine,
  type CodingContext,
  type InvoiceCodingRef,
} from "@/server/features/coding";
import { syncFlags } from "@/server/features/validation";
import { invoiceInputFromDb } from "./input";

/**
 * Feature 3 (smart coding, Youssef's pure engine) on the database.
 *
 *   codeWithin(action, input, vendorId)     analysis pass: suggest every line, save, flag (system)
 *   codeInvoiceLine(actor, id, lineNo, body) a person accepts / changes one line   → invoice.line_coded
 *   acceptConfidentLines(actor, id)          bulk-accept the high-confidence ones  → invoice.line_coded ×n
 *
 * Rules that make it safe to re-run at any time:
 *   - a line a person accepted or changed is NEVER overwritten by a new suggestion;
 *   - coding's flags live in invoice_flags with source = 'coding' and go through the same diff as
 *     validation's (syncFlags), so human overrides survive and stale flags auto-resolve;
 *   - CODING_NOT_CONFIRMED (block) is stored like any flag, so fire('submit') refuses until every
 *     line is confirmed — no separate guard to forget.
 * The learning loop comes for free: history = past invoices + every line people confirmed on
 * invoices that were approved, read from invoice_lines each time.
 */

/** What we keep in invoice_lines.coding_reason (jsonb). */
interface StoredCoding {
  account: AccountSuggestion;
  department: DepartmentSuggestion;
  codedBy: string | null;
  codedAt: string | null;
  note: string | null;
  /** Flags codeLine() raised when a person decided this line (unusual account, other department…). */
  decisionFlags?: Flag[];
}

const APPROVED_STATUSES = ["Approved", "PaymentScheduled", "Paid", "Closed"];

export async function loadCodingContext(db: Executor): Promise<CodingContext> {
  const [gl, depts, vend, taxes, pos, people, historyRows] = await Promise.all([
    db.select().from(glAccounts),
    db.select({ id: departments.id, name: departments.name }).from(departments),
    db.select({ id: vendors.id, legalName: vendors.legalName, category: vendors.category, defaultGlAccount: vendors.defaultGlAccount }).from(vendors),
    db.select().from(taxCodes),
    db.select({ id: purchaseOrders.id, vendorId: purchaseOrders.vendorId, departmentId: purchaseOrders.departmentId, status: purchaseOrders.status }).from(purchaseOrders),
    db.select({ id: users.id, fullName: users.fullName, departmentId: users.departmentId }).from(users),
    db
      .select({
        invoiceId: invoiceLines.invoiceId,
        vendorId: invoices.vendorId,
        invoiceNumber: invoices.invoiceNumber,
        invoiceDate: invoices.invoiceDate,
        source: invoices.source,
        lineNo: invoiceLines.lineNo,
        description: invoiceLines.description,
        amountCents: invoiceLines.amountCents,
        glAccount: invoiceLines.glAccountCode,
        departmentId: invoiceLines.departmentId,
        codingSource: invoiceLines.codingSource,
        codedAt: sql<string | null>`${invoiceLines.codingReason} ->> 'codedAt'`,
      })
      .from(invoiceLines)
      .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
      .where(
        and(
          isNotNull(invoiceLines.glAccountCode),
          isNotNull(invoiceLines.departmentId),
          isNotNull(invoices.vendorId),
          isNotNull(invoices.invoiceDate),
          or(eq(invoices.source, "historical"), and(inArray(invoiceLines.codingSource, ["accepted", "changed"]), inArray(invoices.status, APPROVED_STATUSES))),
        ),
      ),
  ]);
  const glMap = new Map(gl.map((g) => [g.accountNumber, { number: g.accountNumber, name: g.name, type: g.accountType, notes: g.notes }]));
  const apControl = [...glMap.values()].find((a) => a.type === "liability" && /accounts payable/i.test(a.name));
  const history: CodedLine[] = historyRows.map((r) => ({
    invoiceId: r.invoiceId,
    vendorId: r.vendorId!,
    invoiceNumber: r.invoiceNumber,
    invoiceDate: r.invoiceDate!,
    lineNo: r.lineNo,
    description: r.description,
    amountCents: r.amountCents,
    glAccount: r.glAccount!,
    departmentId: r.departmentId!,
    source: r.source === "historical" ? "historical" : (r.codingSource as "accepted" | "changed"),
    codedAt: r.source === "historical" ? null : r.codedAt,
  }));
  return {
    glAccounts: glMap,
    departments: new Map(depts.map((d) => [d.id, d])),
    vendors: new Map(vend.map((v) => [v.id, v])),
    taxCodes: new Map(taxes.map((t) => [t.code, { code: t.code, rate: t.rate, appliesTo: t.appliesTo, recoverable: t.recoverable ? "yes" : "no", glAccount: t.glAccount }])),
    purchaseOrders: pos,
    users: new Map(people.filter((u) => u.departmentId).map((u) => [u.id, { id: u.id, fullName: u.fullName, departmentId: u.departmentId! }])),
    apControlAccount: apControl?.number ?? null,
    history: CodingIndex.from(history),
  };
}

type LineRow = typeof invoiceLines.$inferSelect;

function storedLine(row: LineRow): LineCoding | null {
  const c = row.codingReason as StoredCoding | null;
  if (!c?.account || !c.department) return null;
  return {
    lineNo: row.lineNo,
    description: row.description,
    quantity: Number(row.qty ?? 1), // a decimal quantity, not money
    unitPriceCents: row.unitPriceCents ?? row.amountCents,
    amountCents: row.amountCents,
    lineType: row.lineType === "goods" || row.lineType === "services" ? row.lineType : null,
    account: c.account,
    department: c.department,
    glAccount: row.glAccountCode,
    departmentId: row.departmentId,
    source: (row.codingSource as LineCoding["source"]) ?? "suggested",
    codedBy: c.codedBy,
    codedAt: c.codedAt,
    note: c.note,
  };
}

const toStored = (l: LineCoding, decisionFlags?: Flag[]): StoredCoding => ({
  account: l.account,
  department: l.department,
  codedBy: l.codedBy,
  codedAt: l.codedAt,
  note: l.note,
  ...(decisionFlags?.length ? { decisionFlags } : {}),
});

async function invoiceRef(tx: Executor, invoiceId: string): Promise<InvoiceCodingRef & { version: number; status: string }> {
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!inv) throw new CodingError(`Invoice ${invoiceId} does not exist.`, 404);
  return { invoiceId, vendorId: inv.vendorId, invoiceNumber: inv.invoiceNumber, invoiceDate: inv.invoiceDate, departmentId: inv.departmentId, currency: inv.currency, version: inv.version, status: inv.status };
}

/** All of coding's current flags for the invoice, from the merged lines (see header). */
function currentCodingFlags(input: ValidationInput, lines: readonly LineCoding[], suggestionFlags: readonly Flag[], decided: ReadonlyMap<number, Flag[]>, ctx: CodingContext): Flag[] {
  const decidedNos = new Set(lines.filter((l) => l.source !== "suggested").map((l) => l.lineNo));
  const anySuggested = lines.some((l) => l.source === "suggested");
  const journalCodes = new Set(["CODING_TAX_UNALLOCATED", "CODING_JOURNAL_UNBALANCED", "CODING_NOT_CONFIRMED"]);
  const fromSuggestion = suggestionFlags.filter((f) => {
    if (journalCodes.has(f.code)) return false;
    const lineNo = (f.evidence as { lineNo?: number }).lineNo;
    if (typeof lineNo === "number") return !decidedNos.has(lineNo);
    return anySuggested; // invoice-level suggestion doubts (department uncertain) last until a person decides
  });
  return [...fromSuggestion, ...[...decided.values()].flat(), ...buildJournal(input, lines, ctx).flags, ...codingSubmitFlags(lines)];
}

async function saveCoding(action: ActionContext, invoiceId: string, version: number, input: ValidationInput, lines: LineCoding[], suggestionFlags: Flag[], ctx: CodingContext) {
  const rows = await action.tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
  const decided = new Map<number, Flag[]>();
  for (const r of rows) {
    const flags = (r.codingReason as StoredCoding | null)?.decisionFlags;
    if (flags?.length && r.codingSource !== "suggested") decided.set(r.lineNo, flags);
  }
  await syncFlags(action, { invoiceId, invoiceVersion: version, source: "coding", flags: currentCodingFlags(input, lines, suggestionFlags, decided, ctx) });
}

/**
 * Analysis pass: suggest every line still waiting for a person, keep everyone's decisions, save the
 * flags, and set invoices.department_id from coding's invoiceDepartment when intake left it empty.
 */
export async function codeWithin(action: ActionContext, input: ValidationInput, vendorId: string | null, opts: { ctx?: CodingContext } = {}) {
  const { tx } = action;
  const ref = await invoiceRef(tx, input.invoiceId);
  const ctx = opts.ctx ?? (await loadCodingContext(tx));
  const result = suggestCoding(input, vendorId, ctx);

  const rows = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, input.invoiceId)).for("update");
  const byNo = new Map(rows.map((r) => [r.lineNo, r]));
  const merged: LineCoding[] = [];
  const suggested: { lineNo: number; glAccount: string | null; departmentId: string | null; account: string; department: string }[] = [];
  for (const s of result.lines) {
    const row = byNo.get(s.lineNo);
    const kept = row && row.codingSource && row.codingSource !== "suggested" ? storedLine(row) : null;
    if (kept) {
      merged.push(kept);
      continue;
    }
    merged.push(s);
    if (row) {
      await tx
        .update(invoiceLines)
        .set({ glAccountCode: s.glAccount, departmentId: s.departmentId, codingSource: "suggested", codingReason: toStored(s) })
        .where(eq(invoiceLines.id, row.id));
      suggested.push({ lineNo: s.lineNo, glAccount: s.glAccount, departmentId: s.departmentId, account: `${s.account.confidence}: ${s.account.reason}`, department: `${s.department.confidence}: ${s.department.reason}` });
    }
  }

  if (!ref.departmentId && result.invoiceDepartment.value) {
    await tx.update(invoices).set({ departmentId: result.invoiceDepartment.value, updatedAt: sql`now()` }).where(eq(invoices.id, input.invoiceId));
    await action.audit({
      action: "invoice.edited",
      entityType: "invoice",
      entityId: input.invoiceId,
      invoiceId: input.invoiceId,
      before: { departmentId: null },
      after: { departmentId: result.invoiceDepartment.value },
      reason: `Requesting department suggested by coding (${result.invoiceDepartment.confidence}): ${result.invoiceDepartment.reason}`,
      metadata: { by: "coding" },
    });
  }
  if (suggested.length) {
    await action.audit({
      action: "invoice.coding_suggested",
      entityType: "invoice",
      entityId: input.invoiceId,
      invoiceId: input.invoiceId,
      after: { lines: suggested, journalBalanced: result.journal.balanced },
      metadata: { invoiceVersion: ref.version },
    });
  }
  await saveCoding(action, input.invoiceId, ref.version, input, merged, result.flags, ctx);
  return { result, lines: merged };
}

export class CodingError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409,
    readonly code?: string,
  ) {
    super(message);
    this.name = "CodingError";
  }
}

async function loadForDecision(tx: Executor, invoiceId: string) {
  const ref = await invoiceRef(tx, invoiceId);
  if (!["InReview", "ManualEntry"].includes(ref.status)) throw new CodingError(`Coding can only change while the invoice is in review (it is ${ref.status}).`, 409);
  const rows = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(asc(invoiceLines.lineNo)).for("update");
  const lines = rows.map(storedLine);
  if (lines.some((l) => l === null)) throw new CodingError("This invoice has not been coded yet; run the analysis first.", 409);
  return { ref, rows, lines: lines as LineCoding[] };
}

/** Role check BEFORE any transaction opens: a refusal is logged in its own short transaction. */
async function authorizeCoding(actor: Actor, db: Db, invoiceId: string): Promise<Actor> {
  try {
    return authorize(actor, "invoice.review").actor;
  } catch (err) {
    if (err instanceof Forbidden) await recordDenied(actor, { attempted: "invoice.review (coding)", reason: err.reason, invoiceId }, { db });
    throw err;
  }
}

/** Coding's own actor shape: its checks also refuse inactive users (read from users, not the session). */
async function codingActor(tx: Executor, actor: Actor) {
  const [u] = await tx.select({ status: users.status }).from(users).where(eq(users.id, actor.userId));
  return { id: actor.userId, role: actor.role, status: u?.status ?? "unknown" };
}

async function persistDecisions(
  action: ActionContext,
  invoiceId: string,
  before: readonly LineCoding[],
  after: readonly LineCoding[],
  rows: readonly LineRow[],
  decisionFlags: ReadonlyMap<number, Flag[]>,
  ctx: CodingContext,
  ref: { version: number },
) {
  for (const l of after) {
    const prev = before.find((b) => b.lineNo === l.lineNo)!;
    if (prev.source === l.source && prev.glAccount === l.glAccount && prev.departmentId === l.departmentId && prev.note === l.note) continue;
    const row = rows.find((r) => r.lineNo === l.lineNo)!;
    await action.tx
      .update(invoiceLines)
      .set({ glAccountCode: l.glAccount, departmentId: l.departmentId, codingSource: l.source, codingReason: toStored(l, decisionFlags.get(l.lineNo)) })
      .where(eq(invoiceLines.id, row.id));
    await action.audit({
      action: "invoice.line_coded",
      entityType: "invoice_line",
      entityId: String(row.id),
      invoiceId,
      before: { lineNo: l.lineNo, glAccountCode: prev.glAccount, departmentId: prev.departmentId, codingSource: prev.source },
      after: { lineNo: l.lineNo, glAccountCode: l.glAccount, departmentId: l.departmentId, codingSource: l.source, suggestedAccount: l.account.value, accountConfidence: l.account.confidence },
      reason: l.note,
      metadata: { invoiceVersion: ref.version },
    });
  }
  const input = await invoiceInputFromDb(action.tx, invoiceId);
  // Suggestion-time doubts are recomputed from the pure engine so they stay current.
  const suggestion = suggestCoding(input, (await invoiceRef(action.tx, invoiceId)).vendorId, ctx);
  await saveCoding(action, invoiceId, ref.version, input, [...after], suggestion.flags, ctx);
}

/** A person accepts or changes one line (body: { glAccount, departmentId, note? }). Coding's own checks apply. */
export async function codeInvoiceLine(actor: Actor, invoiceId: string, lineNo: number, body: unknown, opts: { db?: Db; now?: Date } = {}) {
  const db = opts.db ?? getDb();
  const allowed = await authorizeCoding(actor, db, invoiceId);
  return withAction(
    allowed,
    async (action) => {
      const who = await codingActor(action.tx, allowed);
      const { ref, rows, lines } = await loadForDecision(action.tx, invoiceId);
      const ctx = await loadCodingContext(action.tx);
      const res = codeLine(lines, lineNo, body, who, ctx, opts.now ?? new Date(), ref);
      if (!res.ok) throw new CodingError(res.reason, res.status, res.code);
      await persistDecisions(action, invoiceId, lines, res.lines, rows, new Map([[lineNo, res.flags]]), ctx, ref);
      return res.line;
    },
    { db },
  );
}

/** Bulk-accept every still-suggested line at `minimum` confidence or better. */
export async function acceptConfidentLines(actor: Actor, invoiceId: string, opts: { db?: Db; now?: Date; minimum?: "high" | "medium" } = {}) {
  const db = opts.db ?? getDb();
  const allowed = await authorizeCoding(actor, db, invoiceId);
  return withAction(
    allowed,
    async (action) => {
      const who = await codingActor(action.tx, allowed);
      const { ref, rows, lines } = await loadForDecision(action.tx, invoiceId);
      const res = acceptConfident(lines, who, opts.now ?? new Date(), opts.minimum ?? "high");
      if (!res.ok) throw new CodingError(res.reason, res.status, res.code);
      const ctx = await loadCodingContext(action.tx);
      await persistDecisions(action, invoiceId, lines, res.lines, rows, new Map(), ctx, ref);
      return res.accepted;
    },
    { db },
  );
}

