import type { Flag } from "@/contracts/flag";
import type { PriorInvoice, PurchaseOrderRef, ValidationContext } from "../context";
import { countsAsActive, sameInvoiceNumber } from "../derive";
import { makeFlag } from "../flag";
import { formatMoney } from "../lib/money";
import { normalizeInvoiceNumber } from "../lib/text";
import type { Rule } from "./types";

/**
 * Purchase orders (policies P12, P13). The remaining balance is COMPUTED, never stored:
 * PO total − pre-tax subtotals of the non-voided invoices already matched to it (this invoice
 * and its duplicates excluded). Compared on the pre-tax subtotal: recoverable tax is not a cost.
 * A credit note against a PO gives balance back. The dataset has no PO lines, so quantities are
 * not matched (known gap).
 */
export const poRule: Rule = (input, ctx, d) => {
  const flags: Flag[] = [];

  if (!input.poNumber) {
    if (d.vendor?.requiresPo && !d.isCredit) {
      const open = ctx.purchaseOrders
        .filter((p) => p.vendorId === d.vendor!.id && p.status !== "closed")
        .map((p) => ({ poId: p.id, totalCents: p.totalCents, remainingCents: remainingOn(p, input, ctx), currency: p.currency }))
        .filter((p) => p.remainingCents > 0);
      const hint = open.length
        ? ` Open PO${open.length > 1 ? "s" : ""} for this vendor: ${open.map((p) => `${p.poId} (${formatMoney(p.remainingCents, p.currency)} remaining)`).join(", ")} — link one if it covers this invoice.`
        : " No open PO for this vendor.";
      flags.push(
        makeFlag("PO_REQUIRED_MISSING", `${d.vendor.legalName} requires a purchase order and the invoice has none (policy P13).${hint}`, {
          field: "poNumber",
          openPurchaseOrders: open,
          source: `vendor master ${d.vendor.id}`,
        }),
      );
    }
    return flags;
  }

  const po = ctx.purchaseOrders.find((p) => normalizeInvoiceNumber(p.id) === normalizeInvoiceNumber(input.poNumber!));
  if (!po) {
    flags.push(makeFlag("PO_NOT_FOUND", `PO ${input.poNumber} does not exist`, { field: "poNumber", actual: input.poNumber, source: "purchase_orders" }));
    return flags;
  }
  if (d.vendor && po.vendorId !== d.vendor.id) {
    const owner = ctx.vendors.find((v) => v.id === po.vendorId);
    flags.push(
      makeFlag("PO_VENDOR_MISMATCH", `${po.id} was issued to ${owner?.legalName ?? po.vendorId}, but this invoice is from ${d.vendor.legalName}`, {
        field: "poNumber",
        actual: d.vendor.id,
        expected: po.vendorId,
        source: `purchase order ${po.id}`,
      }),
    );
    return flags;
  }
  if (po.status === "closed") {
    flags.push(makeFlag("PO_CLOSED", `${po.id} is closed and cannot take more invoices`, { field: "poNumber", actual: po.status, source: `purchase order ${po.id}` }));
    return flags;
  }

  if (input.departmentId && po.departmentId && input.departmentId !== po.departmentId) {
    flags.push(
      makeFlag("PO_DEPT_MISMATCH", `${po.id} was raised by department ${po.departmentId}; the invoice is for ${input.departmentId}`, {
        field: "departmentId",
        actual: input.departmentId,
        expected: po.departmentId,
        source: `purchase order ${po.id}`,
      }),
    );
  }

  // Invoice subtotal in the PO's currency.
  let subtotal: number | null = null;
  if (d.currency && d.currency !== po.currency) {
    flags.push(
      makeFlag("PO_CURRENCY_MISMATCH", `Invoice is in ${d.currency} but ${po.id} is in ${po.currency}`, {
        field: "currency",
        actual: d.currency,
        expected: po.currency,
        source: `purchase order ${po.id}`,
      }),
    );
    if (po.currency === "CAD") subtotal = d.subtotalCadCents;
  } else {
    subtotal = d.subtotalCents;
  }
  if (subtotal === null || subtotal <= 0) return flags;

  const remaining = remainingOn(po, input, ctx);
  if (subtotal > remaining) {
    const invoiced = po.totalCents - remaining;
    flags.push(
      makeFlag(
        "PO_OVER_BALANCE",
        `Subtotal ${formatMoney(subtotal, po.currency)} exceeds ${po.id}'s remaining balance ${formatMoney(remaining, po.currency)} (PO ${formatMoney(po.totalCents, po.currency)}, already invoiced ${formatMoney(invoiced, po.currency)}) — policy P12 adds a finance-manager approval`,
        {
          field: "poNumber",
          poId: po.id,
          poTotalCents: po.totalCents,
          invoicedCents: invoiced,
          remainingCents: remaining,
          expectedCents: remaining,
          actualCents: subtotal,
          overByCents: subtotal - remaining,
          source: `purchase order ${po.id}`,
        },
      ),
    );
  }
  return flags;
};

/** PO total − subtotals already matched to it (in the PO currency), excluding this invoice and its duplicates. */
export function remainingOn(
  po: PurchaseOrderRef,
  input: { invoiceId: string; invoiceNumber: string | null },
  ctx: Pick<ValidationContext, "priorInvoices">,
): number {
  let invoiced = 0;
  for (const p of ctx.priorInvoices) {
    if (p.poId !== po.id || p.invoiceId === input.invoiceId || !countsAsActive(p)) continue;
    if (input.invoiceNumber && p.vendorId === po.vendorId && sameInvoiceNumber(p.invoiceNumber, input.invoiceNumber)) continue;
    invoiced += amountInPoCurrency(p, po);
  }
  return po.totalCents - invoiced;
}

function amountInPoCurrency(p: PriorInvoice, po: PurchaseOrderRef): number {
  if (p.currency === po.currency) return p.subtotalCents;
  return po.currency === "CAD" ? p.subtotalCadCents : p.subtotalCents;
}

