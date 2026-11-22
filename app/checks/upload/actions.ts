"use server";

import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { can } from "@/server/core/authorize";
import { departments, documents, users } from "@/server/db/schema";
import { ensureDb } from "@/server/demo/database";
import { ingestInvoice, IngestError } from "@/server/pipeline";
import { getViewer } from "@/server/session/current-user";
import { parseMoneyToCents } from "../../_lib/format";

export type UploadForm = {
  fileName: string;
  /** The stored original (documents row), returned when the file was read. */
  documentId?: string;
  vendorName: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  currency: string;
  poNumber: string;
  shipToProvince: string;
  lines: { description: string; quantity: string; unitPrice: string; amount: string }[];
  taxes: { code: string; amount: string }[];
  subtotal: string;
  total: string;
  requesterId: string;
  departmentId: string;
  confidence: Record<string, number>;
};

export type ConfirmResult = { ok: true; invoiceId: string; message: string } | { ok: false; errors: Record<string, string> };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Confirm: checks the fields on the server, then the invoice goes into the database through the real
 * pipeline (ingestInvoice: saved → In review → validation → coding, every step audited, linked to the
 * uploaded file). The person who confirms is the actor; the requester is who asked for it.
 */
export async function confirmUpload(form: UploadForm): Promise<ConfirmResult> {
  const db = await ensureDb();
  const viewer = await getViewer();
  if (!viewer || !can(viewer.actor, "invoice.review")) {
    return { ok: false, errors: { form: "Only people who do the checks can confirm invoices." } };
  }

  const errors: Record<string, string> = {};
  const required = "Required";
  const vendorName = form.vendorName.trim();
  const invoiceNumber = form.invoiceNumber.trim();
  if (!vendorName) errors.vendorName = required;
  if (!invoiceNumber) errors.invoiceNumber = required;
  if (!DATE.test(form.invoiceDate)) errors.invoiceDate = required;
  if (form.dueDate && !DATE.test(form.dueDate)) errors.dueDate = "Use a valid date";
  if (form.currency !== "CAD" && form.currency !== "USD") errors.currency = required;

  const totalCents = parseMoneyToCents(form.total);
  if (totalCents === null) errors.total = form.total.trim() ? "Not a valid amount" : required;
  const subtotalCents = form.subtotal.trim() ? parseMoneyToCents(form.subtotal) : null;
  if (form.subtotal.trim() && subtotalCents === null) errors.subtotal = "Not a valid amount";

  const [requester] = form.requesterId ? await db.select().from(users).where(eq(users.id, form.requesterId)) : [];
  if (!requester || requester.status === "terminated") errors.requesterId = required;
  const [dept] = form.departmentId ? await db.select().from(departments).where(eq(departments.id, form.departmentId)) : [];
  if (!dept) errors.departmentId = required;

  const lines: { lineNo: number; description: string; quantity: number; unitPriceCents: number; amountCents: number; lineType: null }[] = [];
  form.lines.forEach((l, i) => {
    if (!l.description.trim() && !l.quantity.trim() && !l.unitPrice.trim() && !l.amount.trim()) return;
    const quantity = Number(l.quantity);
    const unitPriceCents = parseMoneyToCents(l.unitPrice);
    const amountCents = parseMoneyToCents(l.amount);
    if (!l.quantity.trim() || !Number.isFinite(quantity)) errors[`lines.${i}.quantity`] = "Not a number";
    if (unitPriceCents === null) errors[`lines.${i}.unitPrice`] = "Not a valid amount";
    if (amountCents === null) errors[`lines.${i}.amount`] = "Not a valid amount";
    lines.push({ lineNo: lines.length + 1, description: l.description.trim(), quantity, unitPriceCents: unitPriceCents ?? 0, amountCents: amountCents ?? 0, lineType: null });
  });
  if (lines.length === 0) errors.form = "Enter at least one line.";
  const taxes: { code: string; label: string; ratePct: null; amountCents: number }[] = [];
  form.taxes.forEach((t, i) => {
    if (!t.code && !t.amount.trim()) return;
    const amountCents = parseMoneyToCents(t.amount);
    if (!t.code) errors[`taxes.${i}.code`] = required;
    if (amountCents === null) errors[`taxes.${i}.amount`] = "Not a valid amount";
    taxes.push({ code: t.code, label: t.code, ratePct: null, amountCents: amountCents ?? 0 });
  });

  let documentId: string | null = null;
  if (form.documentId) {
    const [doc] = await db.select({ id: documents.id }).from(documents).where(eq(documents.id, form.documentId));
    documentId = doc?.id ?? null;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());
  const invoiceId = `UP-${today.replace(/-/g, "")}-${randomBytes(3).toString("hex").toUpperCase()}`;
  try {
    const result = await ingestInvoice(
      {
        invoiceId,
        documentType: totalCents! < 0 ? "credit_note" : "invoice",
        vendor: { nameRaw: vendorName, gstHstNumber: null, qstNumber: null, province: null, country: null },
        senderEmail: null,
        invoiceNumber,
        invoiceDate: form.invoiceDate,
        dueDate: form.dueDate || null,
        receivedDate: today,
        currency: form.currency,
        poNumber: form.poNumber.trim() || null,
        shipToProvince: form.shipToProvince || null,
        lines,
        taxes,
        subtotalCents,
        totalCents: totalCents!,
        departmentId: form.departmentId,
        requesterId: form.requesterId,
        confidence: form.confidence,
      },
      { source: "upload", actor: viewer.actor, documentId, today, provenance: { fileName: form.fileName, uploadedBy: viewer.user.id } },
    );
    const flags = result.result.flags.length;
    return { ok: true, invoiceId, message: `Saved. ${vendorName} ${invoiceNumber} is in Checks: ${flags} flag(s), ${result.coding.lines.length} line(s) coded.` };
  } catch (err) {
    if (err instanceof IngestError) return { ok: false, errors: { form: err.message } };
    throw err;
  }
}
