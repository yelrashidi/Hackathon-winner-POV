import type { Flag } from "@/contracts/flag";
import { VALIDATION_CONFIG } from "../config";
import { makeFlag } from "../flag";
import { formatMoney, mulQty } from "../lib/money";
import { normalizeInvoiceNumber } from "../lib/text";
import type { Rule } from "./types";

/**
 * The invoice must add up: qty × unit = line, Σ lines = subtotal, subtotal + taxes = total.
 * Signed cents throughout, so credit notes are checked the same way. Tolerance is 1 cent per
 * contributing line (vendors round per line or per invoice). Also: credit-note signs and the
 * credit note's reference to the invoice it reverses.
 */
export const arithmeticRule: Rule = (input, ctx, d) => {
  const flags: Flag[] = [];
  const cur = d.currency;
  const tol = VALIDATION_CONFIG.centsTolerancePerLine;

  // qty × unit price = amount, per line
  for (const line of input.lines) {
    const expected = mulQty(line.quantity, line.unitPriceCents);
    if (Math.abs(expected - line.amountCents) > tol) {
      flags.push(
        makeFlag(
          "ARITH_LINE_MISMATCH",
          `Line ${line.lineNo}: ${line.quantity} × ${formatMoney(line.unitPriceCents, cur)} = ${formatMoney(expected, cur)}, but the line shows ${formatMoney(line.amountCents, cur)}`,
          { field: "lines.amountCents", lineNo: line.lineNo, expectedCents: expected, actualCents: line.amountCents },
        ),
      );
    }
  }

  // Σ lines = subtotal
  if (input.lines.length > 0 && input.subtotalCents !== null) {
    const sum = input.lines.reduce((s, l) => s + l.amountCents, 0);
    if (Math.abs(sum - input.subtotalCents) > tol * input.lines.length) {
      flags.push(
        makeFlag(
          "ARITH_SUBTOTAL_MISMATCH",
          `Lines add up to ${formatMoney(sum, cur)}, but the subtotal shows ${formatMoney(input.subtotalCents, cur)}`,
          { field: "subtotalCents", expectedCents: sum, actualCents: input.subtotalCents },
        ),
      );
    }
  }

  // subtotal + taxes = total
  if (input.totalCents !== null && d.subtotalCents !== null) {
    const taxSum = input.taxes.reduce((s, t) => s + t.amountCents, 0);
    const expected = d.subtotalCents + taxSum;
    if (Math.abs(expected - input.totalCents) > tol) {
      const parts = [formatMoney(d.subtotalCents, cur), ...input.taxes.map((t) => formatMoney(t.amountCents, cur))].join(" + ");
      flags.push(
        makeFlag(
          "ARITH_TOTAL_MISMATCH",
          `${parts} = ${formatMoney(expected, cur)}, but the total shows ${formatMoney(input.totalCents, cur)}`,
          { field: "totalCents", expectedCents: expected, actualCents: input.totalCents },
        ),
      );
    }
  }

  // Credit-note signs
  const markedCredit = input.documentType === "credit_note";
  if (input.totalCents !== null && input.totalCents !== 0) {
    if (markedCredit && input.totalCents > 0) {
      flags.push(
        makeFlag("CREDIT_NOTE_SIGN", `Marked as a credit note but the total is +${formatMoney(input.totalCents, cur)}; a credit note's total is negative`, {
          field: "totalCents",
          expected: "negative",
          actualCents: input.totalCents,
        }),
      );
    } else if (!markedCredit && input.totalCents < 0) {
      flags.push(
        makeFlag("CREDIT_NOTE_SIGN", `Total is ${formatMoney(input.totalCents, cur)} but the document is not marked as a credit note — confirm it is a credit note before it is processed`, {
          field: "documentType",
          expected: "credit_note",
          actual: input.documentType,
        }),
      );
    }
  }
  if (markedCredit) {
    const positive = input.lines.filter((l) => l.amountCents > 0);
    if (positive.length > 0) {
      flags.push(
        makeFlag(
          "CREDIT_NOTE_SIGN",
          `Credit note has positive line${positive.length > 1 ? "s" : ""} ${positive.map((l) => l.lineNo).join(", ")}; every line of a credit note should be a credit`,
          { field: "lines.amountCents", lineNo: positive[0]!.lineNo, expected: "negative" },
        ),
      );
    }
  }

  // Credit note → the invoice it reverses
  if (markedCredit) {
    const ref = input.creditNoteRef;
    if (!ref) {
      flags.push(
        makeFlag("CREDIT_NOTE_NO_REFERENCE", "Credit note does not say which invoice it reverses — link it to the original invoice", {
          field: "creditNoteRef",
        }),
      );
    } else if (input.invoiceNumber && normalizeInvoiceNumber(ref) === normalizeInvoiceNumber(input.invoiceNumber)) {
      flags.push(
        makeFlag("CREDIT_NOTE_NO_REFERENCE", `Credit note ${input.invoiceNumber} references itself; link it to the invoice it reverses`, {
          field: "creditNoteRef",
          actual: ref,
        }),
      );
    } else {
      const pool = d.vendor ? ctx.priorInvoices.filter((p) => p.vendorId === d.vendor!.id) : ctx.priorInvoices;
      const original = pool.find((p) => normalizeInvoiceNumber(p.invoiceNumber) === normalizeInvoiceNumber(ref));
      if (!original) {
        flags.push(
          makeFlag(
            "CREDIT_NOTE_NO_REFERENCE",
            `Credit note references invoice ${ref}, which we do not hold${d.vendor ? ` for ${d.vendor.legalName}` : ""} — confirm the original before applying the credit`,
            { field: "creditNoteRef", actual: ref },
          ),
        );
      }
    }
  }

  return flags;
};
