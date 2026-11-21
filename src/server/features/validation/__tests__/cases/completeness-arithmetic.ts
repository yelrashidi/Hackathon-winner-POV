import { expect } from "vitest";
import { retotal, type Case } from "../helpers";

export const completenessCases: Case[] = [
  { name: "clean base invoice raises nothing", expect: [] },
  {
    name: "missing invoice number",
    input: (i) => ({ ...i, invoiceNumber: null }),
    expect: ["MISSING_REQUIRED_FIELD"],
    check: (_r, f) => expect(f.MISSING_REQUIRED_FIELD!.message).toMatch(/Invoice number is missing/),
  },
  {
    name: "missing vendor name, total and lines gives one flag per field and no cascade",
    input: (i) => ({ ...i, vendor: { ...i.vendor, nameRaw: null }, totalCents: null, lines: [], subtotalCents: 150000 }),
    expect: ["MISSING_REQUIRED_FIELD"],
    check: (r) => expect(r.flags.filter((f) => f.code === "MISSING_REQUIRED_FIELD").map((f) => f.evidence.field).sort()).toEqual(["lines", "totalCents", "vendor.nameRaw"]),
  },
  {
    name: "missing invoice date skips date, contract and split checks",
    input: (i) => ({ ...i, invoiceDate: null }),
    expect: ["MISSING_REQUIRED_FIELD"],
  },
  {
    name: "low confidence 0.69 fires, 0.70 does not",
    input: (i) => ({ ...i, confidence: { totalCents: 0.69, invoiceDate: 0.7 } }),
    expect: ["LOW_CONFIDENCE_FIELD"],
    check: (r) => {
      const low = r.flags.filter((f) => f.code === "LOW_CONFIDENCE_FIELD");
      expect(low).toHaveLength(1);
      expect(low[0]!.message).toMatch(/Total was read with 69% confidence/);
    },
  },
  {
    name: "EUR is not supported (and differs from the CAD contract)",
    input: (i) => ({ ...i, currency: "EUR" }),
    expect: ["CONTRACT_CURRENCY_MISMATCH", "CURRENCY_UNSUPPORTED"],
    check: (r) => expect(r.totalCadCents).toBeNull(),
  },
  { name: "lower-case cad is accepted", input: (i) => ({ ...i, currency: "cad" }), expect: [] },

  // ---- blank strings mean missing, never a crash ----
  {
    name: 'an empty invoice number ("") is missing, not a crash',
    input: (i) => ({ ...i, invoiceNumber: "" }),
    expect: ["MISSING_REQUIRED_FIELD"],
    check: (_r, f) => expect(f.MISSING_REQUIRED_FIELD!.evidence.field).toBe("invoiceNumber"),
  },
  {
    name: "whitespace-only vendor name and currency are missing",
    input: (i) => ({ ...i, vendor: { ...i.vendor, nameRaw: "   " }, currency: " " }),
    expect: ["MISSING_REQUIRED_FIELD"],
    check: (r) => expect(r.flags.map((f) => f.evidence.field).sort()).toEqual(["currency", "vendor.nameRaw"]),
  },
  { name: 'an empty due date or PO number ("") is simply absent', input: (i) => ({ ...i, dueDate: "", poNumber: "", senderEmail: "" }), expect: [] },
  { name: 'an empty remit-to account ("") means no remit-to', input: (i) => ({ ...i, remitTo: { institution: "", transit: "", account: "" } }), expect: [] },
  { name: "padded values are trimmed (' NW-1001 ')", input: (i) => ({ ...i, invoiceNumber: " NW-1001 ", currency: " CAD " }), expect: [] },

  // ---- impossible calendar dates ----
  {
    name: "invoice date 2026-02-30 is invalid: no age or terms computed from a rolled-over date",
    input: (i) => ({ ...i, invoiceDate: "2026-02-30" }),
    expect: ["INVALID_DATE"],
    check: (r, f) => {
      expect(f.INVALID_DATE!.message).toBe('Invoice date "2026-02-30" is not a real calendar date — date checks skipped until it is corrected; correct it from the document');
      expect(r.flags.filter((x) => x.code === "MISSING_REQUIRED_FIELD")).toEqual([]);
    },
  },
  { name: "due date 2026-02-29 (not a leap year) is invalid", input: (i) => ({ ...i, dueDate: "2026-02-29" }), expect: ["INVALID_DATE"] },
  { name: "2028-02-29 (leap year) is a real date", input: (i) => ({ ...i, invoiceDate: "2028-02-29", receivedDate: "2028-03-01", dueDate: "2028-03-30" }), ctx: (c) => ({ ...c, contracts: [] }), expect: [] },
  { name: "month 13 is invalid", input: (i) => ({ ...i, invoiceDate: "2026-13-01" }), expect: ["INVALID_DATE"] },
  {
    name: "an invalid received date falls back to today for the date checks",
    input: (i) => ({ ...i, receivedDate: "2026-10-32" }),
    expect: ["INVALID_DATE"],
    check: (_r, f) => expect(f.INVALID_DATE!.message).toMatch(/Received date "2026-10-32" is not a real calendar date — using 2026-11-02 instead/),
  },
];

export const arithmeticCases: Case[] = [
  {
    name: "line amount off by 2 cents fires",
    input: (i) => retotal({ ...i, lines: [{ ...i.lines![0]!, amountCents: 100002 }, i.lines![1]!], taxes: [{ code: "HST13", label: "HST", amountCents: 19500 }] }),
    expect: ["ARITH_LINE_MISMATCH"],
    check: (_r, f) => {
      expect(f.ARITH_LINE_MISMATCH!.message).toBe("Line 1: 1 × $1,000.00 = $1,000.00, but the line shows $1,000.02");
      expect(f.ARITH_LINE_MISMATCH!.evidence).toMatchObject({ lineNo: 1, expectedCents: 100000, actualCents: 100002 });
    },
  },
  {
    name: "line amount off by 1 cent is within tolerance",
    input: (i) => retotal({ ...i, lines: [{ ...i.lines![0]!, amountCents: 100001 }, i.lines![1]!], taxes: [{ code: "HST13", label: "HST", amountCents: 19500 }] }),
    expect: [],
  },
  {
    name: "fractional hours round half up once (2.5 × $419.99 = $1,049.98)",
    input: (i) =>
      retotal({
        ...i,
        lines: [{ lineNo: 1, description: "Consulting", quantity: 2.5, unitPriceCents: 41999, amountCents: 104998, lineType: "services" }],
        taxes: [{ code: "HST13", label: "HST", amountCents: 13650 }],
      }),
    expect: [],
  },
  {
    name: "lines do not add up to the subtotal",
    input: (i) => ({ ...i, subtotalCents: 160000, totalCents: 180800, taxes: [{ code: "HST13", label: "HST", amountCents: 20800 }] }),
    expect: ["ARITH_SUBTOTAL_MISMATCH"],
    check: (_r, f) => expect(f.ARITH_SUBTOTAL_MISMATCH!.message).toBe("Lines add up to $1,500.00, but the subtotal shows $1,600.00"),
  },
  {
    name: "subtotal + taxes does not equal the total",
    input: (i) => ({ ...i, totalCents: 179500 }),
    expect: ["ARITH_TOTAL_MISMATCH"],
    check: (_r, f) => expect(f.ARITH_TOTAL_MISMATCH!.message).toBe("$1,500.00 + $195.00 = $1,695.00, but the total shows $1,795.00"),
  },
  {
    name: "negative total on a document not marked as credit note",
    input: (i) => ({
      ...i,
      lines: i.lines!.map((l) => ({ ...l, unitPriceCents: -l.unitPriceCents, amountCents: -l.amountCents })),
      taxes: [{ code: "HST13", label: "HST", amountCents: -19500 }],
      subtotalCents: -150000,
      totalCents: -169500,
    }),
    expect: ["CREDIT_NOTE_SIGN"],
    check: (_r, f) => expect(f.CREDIT_NOTE_SIGN!.evidence.field).toBe("documentType"),
  },
  {
    name: "credit note with a positive total and positive lines",
    input: (i) => ({ ...i, documentType: "credit_note", creditNoteRef: "NW-0900" }),
    ctx: (c) => ({ ...c, priorInvoices: [prior({ invoiceNumber: "NW-0900" })] }),
    expect: ["CREDIT_NOTE_SIGN"],
    check: (r) => expect(r.flags.filter((f) => f.code === "CREDIT_NOTE_SIGN").map((f) => f.evidence.field).sort()).toEqual(["lines.amountCents", "totalCents"]),
  },
  {
    name: "clean credit note referencing an invoice we hold (tax negative, rounds like the invoice)",
    input: creditNote("NW-0900"),
    ctx: (c) => ({ ...c, priorInvoices: [prior({ invoiceNumber: "NW-0900" })] }),
    expect: [],
  },
  { name: "credit note with no reference", input: creditNote(null), expect: ["CREDIT_NOTE_NO_REFERENCE"] },
  {
    name: "credit note referencing itself",
    input: (i) => ({ ...creditNote("CN-77")(i), invoiceNumber: "CN-77" }),
    expect: ["CREDIT_NOTE_NO_REFERENCE"],
    check: (_r, f) => expect(f.CREDIT_NOTE_NO_REFERENCE!.message).toMatch(/references itself/),
  },
  {
    name: "credit note referencing an invoice we do not hold",
    input: creditNote("NW-4040"),
    expect: ["CREDIT_NOTE_NO_REFERENCE"],
    check: (_r, f) => expect(f.CREDIT_NOTE_NO_REFERENCE!.message).toMatch(/NW-4040, which we do not hold for Northwind Freight Ltd\./),
  },
];

export function creditNote(ref: string | null) {
  return (i: Parameters<NonNullable<Case["input"]>>[0]) => ({
    ...i,
    documentType: "credit_note" as const,
    invoiceNumber: "CN-NW-1",
    creditNoteRef: ref,
    lines: [{ lineNo: 1, description: "Credit - damaged freight", quantity: 1, unitPriceCents: -142850, amountCents: -142850, lineType: "services" as const }],
    taxes: [{ code: "HST13", label: "HST", amountCents: -18571 }], // -18570.5 rounds away from zero
    subtotalCents: -142850,
    totalCents: -161421,
  });
}

export function prior(p: Partial<import("../../context").PriorInvoice> = {}): import("../../context").PriorInvoice {
  return {
    invoiceId: `P-${p.invoiceNumber ?? "1"}`,
    vendorId: "V1",
    invoiceNumber: "NW-0900",
    invoiceDate: "2026-09-15",
    currency: "CAD",
    subtotalCents: 100000,
    totalCents: 113000,
    subtotalCadCents: 100000,
    totalCadCents: 113000,
    poId: null,
    contractId: null,
    status: "paid",
    isCreditNote: false,
    taxCodes: ["HST13"],
    ...p,
  };
}
