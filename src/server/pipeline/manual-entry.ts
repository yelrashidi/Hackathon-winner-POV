import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "@/contracts/actor";
import { IsoDate, LineType } from "@/contracts/validation";
import { recordDenied, withAction } from "@/server/core/audit";
import { authorize, Forbidden } from "@/server/core/authorize";
import { fire } from "@/server/core/fire";
import { getDb, type Db } from "@/server/db/client";
import { departments, invoiceLines, invoiceTaxes, invoices, purchaseOrders, users } from "@/server/db/schema";
import { validateWithin } from "@/server/features/validation";
import { codeWithin } from "./coding";
import { IngestError, type AnalysisResult } from "./ingest";
import { invoiceInputFromDb } from "./input";

/**
 * Manual entry (state machine: ManualEntry —fieldsEntered→ InReview, "re-runs analysis").
 * A bill extraction could not read lands in ManualEntry with no fields; a clerk types them from the
 * document shown beside the form. One transaction: authorize → the invoice must still be in
 * ManualEntry → save the fields, lines and taxes → audit (what was typed, and that it was typed) →
 * fire fieldsEntered → validation (4) + coding (3) run on it like on any extracted invoice.
 * What extraction returned (nothing) stays in extraction_raw; the typed values are the evidence now.
 */

const Money = z.number().int();
export const ManualFields = z.object({
  documentType: z.enum(["invoice", "credit_note"]).default("invoice"),
  vendorNameRaw: z.string().trim().min(1, "Vendor is required"),
  invoiceNumber: z.string().trim().min(1, "Invoice number is required"),
  invoiceDate: IsoDate,
  dueDate: IsoDate.nullable().default(null),
  currency: z.enum(["CAD", "USD"]),
  poNumber: z.string().trim().nullable().default(null),
  shipToProvince: z.string().trim().nullable().default(null),
  subtotalCents: Money.nullable().default(null),
  totalCents: Money,
  requesterId: z.string().trim().nullable().default(null),
  departmentId: z.string().trim().nullable().default(null),
  lines: z
    .array(z.object({ description: z.string().trim().min(1), quantity: z.number().finite(), unitPriceCents: Money, amountCents: Money, lineType: LineType.nullable().default(null) }))
    .min(1, "Enter at least one line"),
  taxes: z.array(z.object({ code: z.string().trim().min(1), label: z.string().default(""), ratePct: z.number().nullable().default(null), amountCents: Money })).default([]),
});
export type ManualFields = z.input<typeof ManualFields>;

const norm = (n: string) => n.toUpperCase().replace(/[\s-]/g, "");

export async function enterInvoiceFields(actor: Actor, invoiceId: string, raw: ManualFields, opts: { today?: string; db?: Db } = {}): Promise<AnalysisResult> {
  const db = opts.db ?? getDb();
  let who;
  try {
    who = authorize(actor, "invoice.review").actor;
  } catch (err) {
    if (err instanceof Forbidden) await recordDenied(actor, { attempted: "invoice.review (manual entry)", reason: err.reason, invoiceId }, { db });
    throw err;
  }
  const parsed = ManualFields.safeParse(raw);
  if (!parsed.success) throw new IngestError(parsed.error.issues.map((i) => i.message).join(" · "), 400);
  const f = parsed.data;
  const today = opts.today ?? new Date().toISOString().slice(0, 10);

  return withAction(
    who,
    async (action) => {
      const { tx } = action;
      const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for("update");
      if (!inv) throw new IngestError(`Invoice ${invoiceId} does not exist.`, 404);
      if (inv.status !== "ManualEntry") throw new IngestError(`Only an invoice waiting for manual entry can be typed in (it is ${inv.status}).`, 409);

      // Only link what exists; an unknown PO stays in the typed record and validation flags it.
      const exists = async (q: Promise<unknown[]>) => (await q).length > 0;
      const poOk = f.poNumber ? await exists(tx.select({ id: purchaseOrders.id }).from(purchaseOrders).where(eq(purchaseOrders.id, f.poNumber))) : false;
      if (f.departmentId && !(await exists(tx.select({ id: departments.id }).from(departments).where(eq(departments.id, f.departmentId))))) throw new IngestError(`Department ${f.departmentId} does not exist.`, 400);
      if (f.requesterId && !(await exists(tx.select({ id: users.id }).from(users).where(eq(users.id, f.requesterId))))) throw new IngestError(`User ${f.requesterId} does not exist.`, 400);

      const fields = {
        vendorNameRaw: f.vendorNameRaw,
        invoiceNumber: f.invoiceNumber,
        invoiceNumberNorm: norm(f.invoiceNumber),
        invoiceDate: f.invoiceDate,
        dueDate: f.dueDate,
        currency: f.currency,
        subtotalCents: f.subtotalCents,
        totalCents: f.totalCents,
        shipToProvince: f.shipToProvince,
        isCreditNote: f.documentType === "credit_note" || f.totalCents < 0,
        poId: poOk ? f.poNumber : null,
        departmentId: f.departmentId,
        requesterId: f.requesterId,
      };
      const rawBefore = (inv.extractionRaw ?? {}) as Record<string, unknown>;
      await tx
        .update(invoices)
        .set({ ...fields, extractionRaw: { ...rawBefore, poNumber: f.poNumber, manualEntry: { by: who.userId, at: new Date().toISOString() } }, updatedAt: sql`now()` })
        .where(eq(invoices.id, invoiceId));
      await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
      await tx.delete(invoiceTaxes).where(eq(invoiceTaxes.invoiceId, invoiceId));
      await tx.insert(invoiceLines).values(
        f.lines.map((l, i) => ({ invoiceId, lineNo: i + 1, description: l.description, lineType: l.lineType, qty: String(l.quantity), unitPriceCents: l.unitPriceCents, amountCents: l.amountCents })),
      );
      if (f.taxes.length) {
        await tx.insert(invoiceTaxes).values(f.taxes.map((t) => ({ invoiceId, taxCode: t.code, label: t.label || t.code, rate: t.ratePct === null ? null : String(t.ratePct / 100), amountCents: t.amountCents })));
      }
      await action.audit({
        action: "invoice.edited",
        entityType: "invoice",
        entityId: invoiceId,
        invoiceId,
        before: { status: inv.status, vendorNameRaw: inv.vendorNameRaw, totalCents: inv.totalCents },
        after: { ...fields, lines: f.lines.length, taxes: f.taxes.length },
        reason: "Typed in from the original document (extraction could not read it).",
        metadata: { invoiceVersion: inv.version, manualEntry: true },
      });
      await fire(action, invoiceId, "fieldsEntered");

      const input = await invoiceInputFromDb(tx, invoiceId, today);
      const { result, summary } = await validateWithin(action, input, { today });
      const coding = await codeWithin(action, input, result.vendorId);
      return { invoiceId, status: "InReview", result, summary, coding };
    },
    { db },
  );
}
