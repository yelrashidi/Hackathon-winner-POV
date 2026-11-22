import { eq, sql } from "drizzle-orm";
import { SYSTEM_ACTOR, type Actor } from "@/contracts/actor";
import type { CodingResult, LineCoding } from "@/contracts/coding";
import { ValidationInput, type ValidationInputDraft } from "@/contracts/validation";
import { recordDenied, withAction, type ActionContext } from "@/server/core/audit";
import { authorize, Forbidden } from "@/server/core/authorize";
import { fire } from "@/server/core/fire";
import { getDb, type Db } from "@/server/db/client";
import { departments, invoiceLines, invoiceTaxes, invoices, purchaseOrders, users } from "@/server/db/schema";
import { checkDuplicatesWithin, type DuplicateResult } from "@/server/features/duplicates";
import { validateWithin, type PersistSummary, type ValidationResult } from "@/server/features/validation";
import { codeWithin } from "./coding";
import { invoiceInputFromDb } from "./input";

/**
 * Getting invoices INTO the database and through the analysis pass — any invoice, from any source;
 * nothing here knows the dataset.
 *
 *   ingestInvoice(input, { source })   one transaction:
 *     1. save invoice (Received) + lines + tax lines           audit invoice.created
 *     2. fire extractionSucceeded → InReview                    audit invoice.status_changed
 *     3. validation (4): resolves the vendor, CAD total, flags  audit invoice.edited, flag.*, invoice.validated
 *     4. duplicates (5): earlier copies, card charges          audit flag.*, invoice.duplicates_checked
 *     5. coding (3): GL account + department per line, journal  audit invoice.coding_suggested, flag.*
 *
 *   editInvoice(actor, id, patch)      a clerk corrects fields in review (incl. the requester, which
 *                                      approvals needs) → fieldsEdited → steps 3–5 re-run
 *   revalidateInvoice(id)              re-runs steps 3–5 on the current rows
 *
 * Validation runs first because duplicates and coding take validation's vendor (one vendor for all
 * stages). Duplicates never decides anything: its flags wait for a person on the duplicates dashboard.
 * Human decisions survive every re-run: flag overrides (syncFlags) and confirmed coding lines.
 */

export class IngestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409,
  ) {
    super(message);
    this.name = "IngestError";
  }
}

export interface IngestOptions {
  source: "email" | "upload" | "manual";
  /** Who triggered it: `system` for the email pipeline, the clerk for a manual upload. */
  actor?: Actor;
  documentId?: string | null;
  /** "Today" for the date rules; defaults to the server's date. */
  today?: string;
  /** Where it came from (inbox message, attachment, intake's reason) — kept on `invoice.created`. */
  provenance?: Record<string, unknown>;
  /** Extra original evidence kept next to the input in extraction_raw (e.g. extraction's full reading). */
  evidence?: Record<string, unknown>;
  db?: Db;
}

export interface AnalysisResult {
  invoiceId: string;
  status: string;
  result: ValidationResult;
  summary: PersistSummary;
  duplicates: { result: DuplicateResult; summary: PersistSummary };
  coding: { result: CodingResult; lines: LineCoding[] };
}

const norm = (n: string | null) => (n ? n.toUpperCase().replace(/[\s-]/g, "") : null);
const todayIso = () => new Date().toISOString().slice(0, 10);

/** Steps 3–5 inside an open action. */
async function analyse(action: ActionContext, input: ValidationInput, today: string) {
  const { result, summary } = await validateWithin(action, input, { today });
  const duplicates = await checkDuplicatesWithin(action, input.invoiceId);
  const coding = await codeWithin(action, input, result.vendorId);
  return { result, summary, duplicates, coding };
}

export async function ingestInvoice(draft: ValidationInputDraft, opts: IngestOptions): Promise<AnalysisResult> {
  const parsed = ValidationInput.safeParse(draft);
  if (!parsed.success) throw new IngestError(`Extraction output does not match the ValidationInput contract: ${parsed.error.issues[0]?.message ?? "invalid"}`, 400);
  const input = parsed.data;
  const today = opts.today ?? todayIso();

  return withAction(
    opts.actor ?? SYSTEM_ACTOR,
    async (action) => {
      const { tx } = action;
      const [existing] = await tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.id, input.invoiceId));
      if (existing) throw new IngestError(`Invoice ${input.invoiceId} is already in the database; use revalidateInvoice().`, 409);

      // Only link references that exist; an unknown PO / department / requester stays in
      // extraction_raw and validation flags it — the insert never fails on what a scan said.
      const exists = async (rows: Promise<{ id: string }[]>) => (await rows).length > 0;
      const poOk = input.poNumber ? await exists(tx.select({ id: purchaseOrders.id }).from(purchaseOrders).where(eq(purchaseOrders.id, input.poNumber))) : false;
      const deptOk = input.departmentId ? await exists(tx.select({ id: departments.id }).from(departments).where(eq(departments.id, input.departmentId))) : false;
      const userOk = input.requesterId ? await exists(tx.select({ id: users.id }).from(users).where(eq(users.id, input.requesterId))) : false;

      const row = {
        id: input.invoiceId,
        status: "Received",
        version: 1,
        source: opts.source,
        documentId: opts.documentId ?? null,
        vendorNameRaw: input.vendor.nameRaw,
        invoiceNumber: input.invoiceNumber,
        invoiceNumberNorm: norm(input.invoiceNumber),
        invoiceDate: input.invoiceDate,
        receivedDate: input.receivedDate,
        dueDate: input.dueDate,
        currency: input.currency,
        subtotalCents: input.subtotalCents,
        totalCents: input.totalCents,
        shipToProvince: input.shipToProvince,
        isCreditNote: input.documentType === "credit_note" || (input.totalCents ?? 0) < 0,
        poId: poOk ? input.poNumber : null,
        departmentId: deptOk ? input.departmentId : null,
        requesterId: userOk ? input.requesterId : null,
        extractionRaw: { ...(draft as unknown as Record<string, unknown>), ...opts.evidence },
        extractionConfidence: input.confidence,
      };
      await tx.insert(invoices).values(row);
      if (input.lines.length) {
        await tx.insert(invoiceLines).values(
          input.lines.map((l) => ({ invoiceId: input.invoiceId, lineNo: l.lineNo, description: l.description, lineType: l.lineType, qty: String(l.quantity), unitPriceCents: l.unitPriceCents, amountCents: l.amountCents })),
        );
      }
      if (input.taxes.length) {
        await tx.insert(invoiceTaxes).values(
          input.taxes.map((t) => ({ invoiceId: input.invoiceId, taxCode: t.code, label: t.label, rate: t.ratePct === null ? null : String(t.ratePct / 100), amountCents: t.amountCents })),
        );
      }
      await action.audit({
        action: "invoice.created",
        entityType: "invoice",
        entityId: input.invoiceId,
        invoiceId: input.invoiceId,
        after: {
          status: "Received",
          source: opts.source,
          vendorNameRaw: row.vendorNameRaw,
          invoiceNumber: row.invoiceNumber,
          invoiceDate: row.invoiceDate,
          currency: row.currency,
          totalCents: row.totalCents,
          lines: input.lines.length,
          taxes: input.taxes.length,
        },
        metadata: { documentId: opts.documentId ?? null, ...opts.provenance },
      });

      await fire(action, input.invoiceId, "extractionSucceeded");
      const out = await analyse(action, input, today);
      return { invoiceId: input.invoiceId, status: "InReview", ...out };
    },
    { db: opts.db ?? getDb() },
  );
}

/** Re-runs validation + coding on an invoice already in the database, from its current rows. */
export async function revalidateInvoice(invoiceId: string, opts: { today?: string; db?: Db; actor?: Actor } = {}): Promise<AnalysisResult> {
  const today = opts.today ?? todayIso();
  return withAction(
    opts.actor ?? SYSTEM_ACTOR,
    async (action) => {
      const [inv] = await action.tx.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, invoiceId));
      if (!inv) throw new IngestError(`Invoice ${invoiceId} does not exist.`, 404);
      const input = await invoiceInputFromDb(action.tx, invoiceId, today);
      const out = await analyse(action, input, today);
      return { invoiceId, status: inv.status, ...out };
    },
    { db: opts.db ?? getDb() },
  );
}

/** Fields a clerk may correct while the invoice is in review. */
export interface InvoicePatch {
  requesterId?: string | null;
  departmentId?: string | null;
  poId?: string | null;
  shipToProvince?: string | null;
  invoiceNumber?: string | null;
  invoiceDate?: string | null;
  dueDate?: string | null;
  currency?: string | null;
  subtotalCents?: number | null;
  totalCents?: number | null;
}
const PATCHABLE = ["requesterId", "departmentId", "poId", "shipToProvince", "invoiceNumber", "invoiceDate", "dueDate", "currency", "subtotalCents", "totalCents"] as const;

/**
 * A clerk corrects fields in review (state machine: InReview —fieldsEdited→ InReview, "re-runs
 * analysis"). One transaction: authorize → check references exist → update → audit the changed
 * fields → fire → validation + coding re-run on the corrected invoice.
 */
export async function editInvoice(actor: Actor, invoiceId: string, patch: InvoicePatch, opts: { reason?: string; today?: string; db?: Db } = {}): Promise<AnalysisResult> {
  const db = opts.db ?? getDb();
  let who;
  try {
    who = authorize(actor, "invoice.review").actor;
  } catch (err) {
    if (err instanceof Forbidden) await recordDenied(actor, { attempted: "invoice.review", reason: err.reason, invoiceId }, { db });
    throw err;
  }
  const today = opts.today ?? todayIso();
  return withAction(
    who,
    async (action) => {
      const { tx } = action;
      const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for("update");
      if (!inv) throw new IngestError(`Invoice ${invoiceId} does not exist.`, 404);
      if (inv.status !== "InReview" && inv.status !== "ManualEntry") throw new IngestError(`Fields can only be corrected in review (the invoice is ${inv.status}).`, 409);

      const check = async (label: string, id: string | null | undefined, q: (id: string) => Promise<unknown[]>) => {
        if (id && (await q(id)).length === 0) throw new IngestError(`${label} ${id} does not exist.`, 400);
      };
      await check("User", patch.requesterId, (id) => tx.select({ id: users.id }).from(users).where(eq(users.id, id)));
      await check("Department", patch.departmentId, (id) => tx.select({ id: departments.id }).from(departments).where(eq(departments.id, id)));
      await check("Purchase order", patch.poId, (id) => tx.select({ id: purchaseOrders.id }).from(purchaseOrders).where(eq(purchaseOrders.id, id)));

      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const k of PATCHABLE) {
        if (patch[k] === undefined || patch[k] === inv[k]) continue;
        before[k] = inv[k];
        after[k] = patch[k];
      }
      if (!Object.keys(after).length) throw new IngestError("Nothing to change.", 400);
      const update: Record<string, unknown> = { ...after, updatedAt: sql`now()` };
      if ("invoiceNumber" in after) update.invoiceNumberNorm = norm(after.invoiceNumber as string | null);
      await tx.update(invoices).set(update).where(eq(invoices.id, invoiceId));
      await action.audit({ action: "invoice.edited", entityType: "invoice", entityId: invoiceId, invoiceId, before, after, reason: opts.reason ?? null, metadata: { invoiceVersion: inv.version } });

      if (inv.status === "InReview") await fire(action, invoiceId, "fieldsEdited");
      else await fire(action, invoiceId, "fieldsEntered");
      const input = await invoiceInputFromDb(tx, invoiceId, today);
      const out = await analyse(action, input, today);
      return { invoiceId, status: "InReview", ...out };
    },
    { db },
  );
}
