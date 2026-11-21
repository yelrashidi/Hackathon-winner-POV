import type { LineType, ValidationInputDraft } from "@/contracts/validation";
import { parseMoneyToCents } from "../lib/money";
import type { DatasetTables } from "./load-context";

/**
 * The 426 historical invoices as ValidationInputs, for the false-positive replay
 * (scripts/validate-history.ts). The CSV keeps tax per invoice (gst_hst_amount, pst_qst_amount)
 * and codes per line; this turns them into tax lines like extraction would produce.
 * No remit-to details exist in the history, so bank checks only see what the vendor master says.
 */
export function historicalInputs(tables: DatasetTables): ValidationInputDraft[] {
  const vendors = new Map(tables.vendors.map((v) => [v.vendor_id!, v]));
  const linesBy = new Map<string, Record<string, string>[]>();
  for (const l of tables.invoiceLines) {
    const list = linesBy.get(l.invoice_id!) ?? [];
    list.push(l);
    linesBy.set(l.invoice_id!, list);
  }

  return tables.invoices.map((r) => {
    const v = vendors.get(r.vendor_id!);
    const lines = (linesBy.get(r.invoice_id!) ?? []).sort((a, b) => Number(a.line_no) - Number(b.line_no));
    const gstCodes = [...new Set(lines.map((l) => l.gst_hst_code!).filter(Boolean))];
    const pstCodes = [...new Set(lines.map((l) => l.pst_qst_code!).filter(Boolean))];
    const gstAmount = parseMoneyToCents(r.gst_hst_amount || "0");
    const pstAmount = parseMoneyToCents(r.pst_qst_amount || "0");

    const taxes: NonNullable<ValidationInputDraft["taxes"]> = [];
    const rated = gstCodes.find((c) => c === "HST13" || c === "GST5");
    if (gstAmount !== 0) taxes.push({ code: rated ?? null, label: rated ?? "GST/HST", amountCents: gstAmount });
    else for (const zero of gstCodes.filter((c) => c === "EXEMPT" || c === "FOREIGN")) taxes.push({ code: zero, label: zero, amountCents: 0 });
    if (pstAmount !== 0) taxes.push({ code: pstCodes[0] ?? null, label: pstCodes[0] ?? "PST/QST", amountCents: pstAmount });

    const total = parseMoneyToCents(r.total!);
    return {
      invoiceId: r.invoice_id!,
      documentType: total < 0 ? "credit_note" : "invoice",
      vendor: {
        nameRaw: v?.legal_name ?? null,
        gstHstNumber: v?.gst_hst_number || null,
        qstNumber: v?.qst_number || null,
        province: v?.province_or_state || null,
        country: v?.country || null,
      },
      senderEmail: v?.ap_contact_email || null,
      invoiceNumber: r.vendor_invoice_number || null,
      invoiceDate: r.invoice_date || null,
      dueDate: r.due_date || null,
      receivedDate: r.received_date || r.invoice_date!,
      currency: r.currency || null,
      poNumber: r.po_id || null,
      contractRef: r.contract_id || null,
      shipToProvince: r.ship_to_province || null,
      departmentId: r.department_id || null,
      requesterId: r.requester_user_id || null,
      lines: lines.map((l) => ({
        lineNo: Number(l.line_no),
        description: l.description!,
        quantity: Number(l.quantity),
        unitPriceCents: parseMoneyToCents(l.unit_price!),
        amountCents: parseMoneyToCents(l.amount!),
        lineType: (l.line_type === "goods" || l.line_type === "services" ? l.line_type : null) as LineType | null,
      })),
      taxes,
      subtotalCents: parseMoneyToCents(r.subtotal!),
      totalCents: total,
    };
  });
}
