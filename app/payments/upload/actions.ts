"use server";

import { getCurrentUser } from "@/server/session/current-user";
import { findUser } from "@/server/session/users";
import { parseMoneyToCents } from "../_lib/format";
import { listDepartments, listTaxCodes } from "../_lib/reference-data";
import { nextUploadId, saveUploadedInvoice, type UploadedInvoiceInput } from "../_lib/upload-store";
import { canUpload } from "../_lib/upload-rules";

export type UploadForm = {
  fileName: string;
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

export type ConfirmResult =
  | { ok: true; invoiceId: string; message: string }
  | { ok: false; errors: Record<string, string> };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Confirm: checks the fields on the server and saves the invoice as In review. */
export async function confirmUpload(form: UploadForm): Promise<ConfirmResult> {
  const user = await getCurrentUser();
  if (!user || !canUpload(user.role)) {
    return { ok: false, errors: { form: "Only AP Clerks and Controllers can confirm invoices." } };
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

  const requester = findUser(form.requesterId);
  if (!requester || requester.status === "terminated") errors.requesterId = required;
  if (!listDepartments().some((d) => d.value === form.departmentId)) errors.departmentId = required;

  // Lines and taxes: skip blank rows, check the rest.
  const lines: UploadedInvoiceInput["lines"] = [];
  form.lines.forEach((l, i) => {
    if (!l.description.trim() && !l.quantity.trim() && !l.unitPrice.trim() && !l.amount.trim()) return;
    const quantity = Number(l.quantity);
    const unitPriceCents = parseMoneyToCents(l.unitPrice);
    const amountCents = parseMoneyToCents(l.amount);
    if (!l.quantity.trim() || !Number.isFinite(quantity)) errors[`lines.${i}.quantity`] = "Not a number";
    if (unitPriceCents === null) errors[`lines.${i}.unitPrice`] = "Not a valid amount";
    if (amountCents === null) errors[`lines.${i}.amount`] = "Not a valid amount";
    lines.push({
      lineNo: lines.length + 1,
      description: l.description.trim(),
      quantity,
      unitPriceCents: unitPriceCents ?? 0,
      amountCents: amountCents ?? 0,
      lineType: null,
    });
  });
  const taxCodes = listTaxCodes();
  const taxes: UploadedInvoiceInput["taxes"] = [];
  form.taxes.forEach((t, i) => {
    if (!t.code && !t.amount.trim()) return;
    const code = taxCodes.find((c) => c.value === t.code);
    const amountCents = parseMoneyToCents(t.amount);
    if (!code) errors[`taxes.${i}.code`] = required;
    if (amountCents === null) errors[`taxes.${i}.amount`] = "Not a valid amount";
    taxes.push({ code: t.code, label: code?.label ?? t.code, ratePct: null, amountCents: amountCents ?? 0 });
  });

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const invoiceId = nextUploadId();
  const now = new Date();
  saveUploadedInvoice({
    invoiceId,
    status: "InReview",
    fileName: form.fileName,
    uploadedBy: { userId: user.id, name: user.fullName },
    uploadedAt: now.toISOString(),
    input: {
      invoiceId,
      documentType: "invoice",
      vendor: { nameRaw: vendorName, gstHstNumber: null, qstNumber: null, province: null, country: null },
      senderEmail: null,
      invoiceNumber,
      invoiceDate: form.invoiceDate,
      dueDate: form.dueDate || null,
      receivedDate: new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(now),
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
  });

  return { ok: true, invoiceId, message: `Saved. ${vendorName} invoice ${invoiceNumber} is now in review.` };
}
