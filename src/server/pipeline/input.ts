import { asc, eq } from "drizzle-orm";
import { ValidationInput, type ValidationInputDraft } from "@/contracts/validation";
import type { Executor } from "@/server/db/client";
import { invoiceLines, invoiceTaxes, invoices } from "@/server/db/schema";

/**
 * The invoice as the analysis stages read it (`ValidationInput`), rebuilt from the CURRENT rows,
 * so a clerk's edits count. Fields the tables do not hold (vendor tax numbers, remit-to, bill-to,
 * sender, confidence…) come from the stored extraction output.
 */
export async function invoiceInputFromDb(db: Executor, invoiceId: string, fallbackToday?: string): Promise<ValidationInput> {
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!inv) throw new Error(`Invoice ${invoiceId} does not exist.`);
  const [lines, taxes] = await Promise.all([
    db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(asc(invoiceLines.lineNo)),
    db.select().from(invoiceTaxes).where(eq(invoiceTaxes.invoiceId, invoiceId)).orderBy(asc(invoiceTaxes.id)),
  ]);
  const raw = (inv.extractionRaw ?? {}) as Partial<ValidationInputDraft>;
  const draft: ValidationInputDraft = {
    ...raw,
    invoiceId,
    documentType: inv.isCreditNote ? "credit_note" : "invoice",
    vendor: { ...(raw.vendor ?? {}), nameRaw: inv.vendorNameRaw },
    invoiceNumber: inv.invoiceNumber,
    invoiceDate: inv.invoiceDate,
    dueDate: inv.dueDate,
    receivedDate: inv.receivedDate ?? inv.invoiceDate ?? fallbackToday ?? new Date().toISOString().slice(0, 10),
    currency: inv.currency,
    poNumber: inv.poId ?? raw.poNumber ?? null,
    contractRef: raw.contractRef ?? inv.contractId ?? null,
    shipToProvince: inv.shipToProvince,
    departmentId: inv.departmentId ?? raw.departmentId ?? null,
    requesterId: inv.requesterId ?? raw.requesterId ?? null,
    subtotalCents: inv.subtotalCents,
    totalCents: inv.totalCents,
    lines: lines.map((l) => ({
      lineNo: l.lineNo,
      description: l.description,
      quantity: Number(l.qty ?? 1), // a decimal quantity, not money (ValidationLine.quantity is a number)
      unitPriceCents: l.unitPriceCents ?? l.amountCents,
      amountCents: l.amountCents,
      lineType: l.lineType === "goods" || l.lineType === "services" ? l.lineType : null,
    })),
    taxes: taxes.map((t) => ({ code: t.taxCode, label: t.label ?? t.taxCode ?? "", ratePct: t.rate === null ? null : Number(t.rate) * 100, amountCents: t.amountCents })),
  };
  return ValidationInput.parse(draft);
}
