import { expect } from "vitest";
import type { ValidationInputDraft } from "@/contracts/validation";
import { retotal, type Case } from "../helpers";
import { prior } from "./completeness-arithmetic";

/** Sets the invoice total to `cents` CAD (one HST-taxed line), keeping it internally consistent. */
const amount = (subtotalCents: number) => (i: ValidationInputDraft): ValidationInputDraft =>
  retotal({
    ...i,
    lines: [{ lineNo: 1, description: "Dock door repair", quantity: 1, unitPriceCents: subtotalCents, amountCents: subtotalCents, lineType: "services" }],
    taxes: [{ code: "HST13", label: "HST", amountCents: Math.round(subtotalCents * 0.13) }],
  });

const usd = (date: string) => (i: ValidationInputDraft): ValidationInputDraft => ({ ...i, currency: "USD", invoiceDate: date, dueDate: null });
const noContract = (c: Parameters<NonNullable<Case["ctx"]>>[0]) => ({ ...c, contracts: c.contracts.filter((k) => k.vendorId !== "V1") });

export const dateCases: Case[] = [
  {
    name: "invoice dated after it was received",
    input: (i) => ({ ...i, invoiceDate: "2026-10-20", dueDate: "2026-11-19" }),
    expect: ["DATE_IN_FUTURE"],
    check: (_r, f) => expect(f.DATE_IN_FUTURE!.message).toBe("Invoice dated 2026-10-20, 9 days after it was received (2026-10-11)"),
  },
  {
    name: "received 91 days after the invoice date",
    input: (i) => ({ ...i, invoiceDate: "2026-07-12", dueDate: "2026-08-11" }),
    expect: ["DATE_TOO_OLD"],
    check: (_r, f) => expect(f.DATE_TOO_OLD!.message).toMatch(/received 2026-10-11, 91 days later \(limit 90\)/),
  },
  { name: "received exactly 90 days after is fine", input: (i) => ({ ...i, invoiceDate: "2026-07-13", dueDate: "2026-08-12" }), expect: [] },
  {
    name: "due date before the invoice date",
    input: (i) => ({ ...i, dueDate: "2026-10-01" }),
    expect: ["DUE_BEFORE_INVOICE"],
  },
  {
    name: "due date does not follow the vendor's terms (info)",
    input: (i) => ({ ...i, dueDate: "2026-10-25" }),
    expect: ["TERMS_MISMATCH"],
    check: (_r, f) => expect(f.TERMS_MISMATCH!.message).toBe("Due 2026-10-25 is 15 days after the invoice date; Northwind Freight Ltd.'s terms on file are Net 30"),
  },
  { name: "terms within one day are fine", input: (i) => ({ ...i, dueDate: "2026-11-10" }), expect: [] },
];

export const fxCases: Case[] = [
  { name: "USD invoice with a rate on its date", input: usd("2026-10-09"), ctx: noContract, expect: [], check: (r) => expect(r.totalCadCents).toBe(233063) },
  {
    name: "USD invoice on a weekend uses the nearest earlier rate",
    input: usd("2026-10-11"),
    ctx: noContract,
    expect: [],
    check: (r) => {
      expect(r.fxRate).toBe("1.3750");
      expect(r.totalCadCents).toBe(233063); // 169,500 × 1.3750 = 233,062.5 → 233,063
    },
  },
  {
    name: "no rate within the lookback window",
    input: (i) => ({ ...usd("2026-10-30")(i), receivedDate: "2026-10-31" }),
    ctx: noContract,
    expect: ["FX_RATE_MISSING"],
    check: (r) => expect(r.totalCadCents).toBeNull(),
  },
  { name: "a later rate is never used", input: usd("2026-10-07"), ctx: noContract, expect: ["FX_RATE_MISSING"] },
  {
    name: "stated rate 0.6% off the table",
    input: (i) => ({ ...usd("2026-10-09")(i), statedFxRate: 1.3833 }),
    ctx: noContract,
    expect: ["FX_RATE_MISMATCH"],
  },
  { name: "stated rate 0.4% off the table is fine", input: (i) => ({ ...usd("2026-10-09")(i), statedFxRate: 1.3805 }), ctx: noContract, expect: [] },
];

export const splitCases: Case[] = [
  {
    name: "three same-vendor invoices within 3 days, each under $10k, together over it",
    input: amount(800000),
    ctx: (c) => ({
      ...noContract(c),
      priorInvoices: [
        prior({ invoiceNumber: "NW-1000", invoiceId: "P-A", invoiceDate: "2026-10-09", totalCadCents: 450000, totalCents: 450000 }),
        prior({ invoiceNumber: "NW-1002", invoiceId: "P-B", invoiceDate: "2026-10-12", totalCadCents: 300000, totalCents: 300000 }),
      ],
    }),
    expect: ["SPLIT_INVOICE_SUSPECTED"],
    check: (_r, f) => {
      const s = f.SPLIT_INVOICE_SUSPECTED!;
      expect(s.evidence).toMatchObject({ combinedCadCents: 1_654_000, thresholdCadCents: 1_000_000, relatedInvoiceIds: ["P-A", "P-B"] });
      expect(Number.isInteger(s.evidence.combinedCadCents)).toBe(true);
      expect(s.relatedInvoiceId).toBe("P-A");
      expect(s.message).toMatch(/combined \$16,540\.00 CAD within 3 days/);
    },
  },
  {
    name: "4 days apart is outside the window",
    input: amount(800000),
    ctx: (c) => ({ ...noContract(c), priorInvoices: [prior({ invoiceNumber: "NW-1000", invoiceId: "P-A", invoiceDate: "2026-10-06", totalCadCents: 450000 })] }),
    expect: [],
  },
  {
    name: "together still under the limit",
    input: amount(400000),
    ctx: (c) => ({ ...noContract(c), priorInvoices: [prior({ invoiceNumber: "NW-1000", invoiceId: "P-A", invoiceDate: "2026-10-10", totalCadCents: 450000 })] }),
    expect: [],
  },
  {
    name: "the highest crossed threshold is used ($50k tier)",
    input: amount(3_000_000),
    ctx: (c) => ({ ...noContract(c), priorInvoices: [prior({ invoiceNumber: "NW-1000", invoiceId: "P-A", invoiceDate: "2026-10-10", totalCadCents: 4_000_000 })] }),
    expect: ["SPLIT_INVOICE_SUSPECTED"],
    check: (_r, f) => expect(f.SPLIT_INVOICE_SUSPECTED!.evidence).toMatchObject({ thresholdCadCents: 5_000_000, combinedCadCents: 7_390_000 }),
  },
  {
    name: "credit notes, duplicates and rejected invoices never make a split",
    input: amount(800000),
    ctx: (c) => ({
      ...noContract(c),
      priorInvoices: [
        prior({ invoiceNumber: "CN-1", invoiceId: "P-CN", invoiceDate: "2026-10-10", totalCadCents: -450000, isCreditNote: true }),
        prior({ invoiceNumber: "NW-1001-A", invoiceId: "P-DUP", invoiceDate: "2026-10-10", totalCadCents: 450000 }),
        prior({ invoiceNumber: "NW-1003", invoiceId: "P-REJ", invoiceDate: "2026-10-10", totalCadCents: 450000, status: "rejected" }),
      ],
    }),
    expect: [],
  },
  {
    name: "another vendor's invoices do not count",
    input: amount(800000),
    ctx: (c) => ({ ...noContract(c), priorInvoices: [prior({ vendorId: "V2", invoiceNumber: "MO-1", invoiceId: "P-MO", invoiceDate: "2026-10-10", totalCadCents: 450000 })] }),
    expect: [],
  },
];
