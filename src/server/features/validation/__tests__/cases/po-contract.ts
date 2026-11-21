import { expect } from "vitest";
import type { ValidationInputDraft } from "@/contracts/validation";
import { retotal, type Case } from "../helpers";
import { prior } from "./completeness-arithmetic";

/** An invoice from Maple Office Supply (requires a PO; PO-1 = $1,000.00 open, PO-2 closed). */
const maple = (subtotalCents: number, po: string | null) => (i: ValidationInputDraft): ValidationInputDraft =>
  retotal({
    ...i,
    vendor: { nameRaw: "Maple Office Supply Inc.", gstHstNumber: "222222226RT0001", qstNumber: null, province: "ON", country: "CA" },
    senderEmail: "ar@mapleoffice.example",
    invoiceNumber: "MO-55",
    poNumber: po,
    remitTo: { institution: "002", transit: "22222", account: "2222222" },
    lines: [{ lineNo: 1, description: "Printer paper cartons", quantity: 1, unitPriceCents: subtotalCents, amountCents: subtotalCents, lineType: "goods" }],
    taxes: [{ code: "HST13", label: "HST", amountCents: Math.round(subtotalCents * 0.13) }],
  });

/** An invoice from Cloudly Software (fixed monthly fee $1,000.00, contract C-FIX). */
const cloudly = (lines: { d: string; c: number }[], date = "2026-10-10") => (i: ValidationInputDraft): ValidationInputDraft => {
  const ls = lines.map((l, k) => ({ lineNo: k + 1, description: l.d, quantity: 1, unitPriceCents: l.c, amountCents: l.c, lineType: "services" as const }));
  const sub = ls.reduce((s, l) => s + l.amountCents, 0);
  return retotal({
    ...i,
    vendor: { nameRaw: "Cloudly Software Inc.", gstHstNumber: "888888884RT0001", qstNumber: null, province: "ON", country: "CA" },
    senderEmail: "ar@cloudly.example",
    invoiceNumber: "CL-10",
    invoiceDate: date,
    receivedDate: date,
    dueDate: null,
    remitTo: null,
    lines: ls,
    taxes: [{ code: "HST13", label: "HST", amountCents: Math.round(sub * 0.13) }],
  });
};

/** An invoice from Lex Partners (hourly cap $500.00, monthly NTE $15,000.00). */
const lex = (lines: { d: string; q: number; u: number }[]) => (i: ValidationInputDraft): ValidationInputDraft => {
  const ls = lines.map((l, k) => ({ lineNo: k + 1, description: l.d, quantity: l.q, unitPriceCents: l.u, amountCents: Math.round(l.q * l.u), lineType: "services" as const }));
  const sub = ls.reduce((s, l) => s + l.amountCents, 0);
  return retotal({
    ...i,
    vendor: { nameRaw: "Lex Partners LLP", gstHstNumber: "999999992RT0001", qstNumber: null, province: "ON", country: "CA" },
    senderEmail: "ar@lexpartners.example",
    invoiceNumber: "LX-3",
    remitTo: null,
    lines: ls,
    taxes: [{ code: "HST13", label: "HST", amountCents: Math.round(sub * 0.13) }],
  });
};

/** Northwind freight with a fuel-surcharge line (contract C-RATE caps fuel at 12%). */
const freight = (fuelDesc: string, fuelCents: number) => (i: ValidationInputDraft): ValidationInputDraft =>
  retotal({
    ...i,
    lines: [...i.lines!, { lineNo: 3, description: fuelDesc, quantity: 1, unitPriceCents: fuelCents, amountCents: fuelCents, lineType: "services" }],
    taxes: [{ code: "HST13", label: "HST", amountCents: Math.round((150000 + fuelCents) * 0.13) }],
  });

export const poCases: Case[] = [
  {
    name: "vendor requires a PO, none given: open POs with remaining balance are listed",
    input: maple(40000, null),
    expect: ["PO_REQUIRED_MISSING"],
    check: (_r, f) => {
      expect(f.PO_REQUIRED_MISSING!.message).toBe(
        "Maple Office Supply Inc. requires a purchase order and the invoice has none (policy P13). Open PO for this vendor: PO-1 ($1,000.00 remaining) — link one if it covers this invoice.",
      );
      expect(f.PO_REQUIRED_MISSING!.severity).toBe("warn");
    },
  },
  {
    name: "credit note from a PO vendor is not held for a missing PO",
    input: (i) => ({
      ...maple(40000, null)(i),
      documentType: "credit_note",
      creditNoteRef: "MO-50",
      lines: [{ lineNo: 1, description: "Credit - returned cartons", quantity: 1, unitPriceCents: -40000, amountCents: -40000, lineType: "goods" }],
      taxes: [{ code: "HST13", label: "HST", amountCents: -5200 }],
      subtotalCents: -40000,
      totalCents: -45200,
    }),
    ctx: (c) => ({ ...c, priorInvoices: [prior({ vendorId: "V2", invoiceNumber: "MO-50", invoiceId: "P-MO-50" })] }),
    expect: [],
  },
  { name: "PO within its balance is clean", input: maple(40000, "PO-1"), expect: [] },
  { name: "PO number formatted differently still matches (po 1)", input: maple(40000, "po 1"), expect: [] },
  { name: "subtotal exactly equal to the remaining balance is clean", input: maple(100000, "PO-1"), expect: [] },
  {
    name: "subtotal 1 cent over the remaining balance",
    input: maple(100001, "PO-1"),
    expect: ["PO_OVER_BALANCE"],
    check: (_r, f) => expect(f.PO_OVER_BALANCE!.evidence).toMatchObject({ poId: "PO-1", remainingCents: 100000, overByCents: 1 }),
  },
  {
    name: "earlier invoices on the PO use up the balance (pre-tax subtotals)",
    input: maple(40000, "PO-1"),
    ctx: (c) => ({ ...c, priorInvoices: [prior({ vendorId: "V2", invoiceNumber: "MO-40", invoiceId: "P-MO-40", poId: "PO-1", subtotalCents: 70000, subtotalCadCents: 70000, totalCents: 79100, totalCadCents: 79100 })] }),
    expect: ["PO_OVER_BALANCE"],
    check: (_r, f) =>
      expect(f.PO_OVER_BALANCE!.message).toBe(
        "Subtotal $400.00 exceeds PO-1's remaining balance $300.00 (PO $1,000.00, already invoiced $700.00) — policy P12 adds a finance-manager approval",
      ),
  },
  {
    name: "a credit note on the PO gives balance back; rejected invoices do not count",
    input: maple(40000, "PO-1"),
    ctx: (c) => ({
      ...c,
      priorInvoices: [
        prior({ vendorId: "V2", invoiceNumber: "MO-40", invoiceId: "P-MO-40", poId: "PO-1", subtotalCents: 70000, subtotalCadCents: 70000 }),
        prior({ vendorId: "V2", invoiceNumber: "CN-MO-40", invoiceId: "P-CN", poId: "PO-1", subtotalCents: -20000, subtotalCadCents: -20000, isCreditNote: true }),
        prior({ vendorId: "V2", invoiceNumber: "MO-41", invoiceId: "P-MO-41", poId: "PO-1", subtotalCents: 90000, subtotalCadCents: 90000, status: "rejected" }),
      ],
    }),
    expect: [],
  },
  {
    name: "a resubmitted copy of this invoice does not consume the balance twice",
    input: maple(80000, "PO-1"),
    ctx: (c) => ({ ...c, priorInvoices: [prior({ vendorId: "V2", invoiceNumber: "MO-55", invoiceId: "P-MO-55", poId: "PO-1", subtotalCents: 80000, subtotalCadCents: 80000 })] }),
    expect: [],
  },
  { name: "unknown PO number", input: maple(40000, "PO-404"), expect: ["PO_NOT_FOUND"] },
  {
    name: "PO belonging to another vendor",
    input: maple(40000, "PO-3"),
    expect: ["PO_VENDOR_MISMATCH"],
    check: (_r, f) => expect(f.PO_VENDOR_MISMATCH!.message).toBe("PO-3 was issued to Northwind Freight Ltd., but this invoice is from Maple Office Supply Inc."),
  },
  { name: "closed PO", input: maple(40000, "PO-2"), expect: ["PO_CLOSED"] },
  { name: "PO raised by another department (info)", input: (i) => ({ ...maple(40000, "PO-1")(i), departmentId: "D7" }), expect: ["PO_DEPT_MISMATCH"] },
  {
    name: "USD invoice against a CAD PO: compared in CAD",
    input: (i) => ({ ...maple(40000, "PO-1")(i), currency: "USD", invoiceDate: "2026-10-09" }),
    expect: ["PO_CURRENCY_MISMATCH"],
  },
];

export const contractCases: Case[] = [
  // ---- term ----
  {
    name: "invoice after the contract ended",
    input: (i) => ({ ...i, invoiceDate: "2026-10-10" }),
    ctx: (c) => ({ ...c, contracts: c.contracts.map((k) => (k.id === "C-RATE" ? { ...k, endDate: "2026-06-30" } : k)) }),
    expect: ["CONTRACT_EXPIRED"],
    check: (_r, f) => expect(f.CONTRACT_EXPIRED!.message).toBe("Invoice dated 2026-10-10, but contract C-RATE (Freight rate card) ended 2026-06-30 — confirm the rates still apply or renew the contract"),
  },
  {
    name: "contract marked expired even if auto-renew is set",
    ctx: (c) => ({ ...c, contracts: c.contracts.map((k) => (k.id === "C-RATE" ? { ...k, endDate: "2026-06-30", autoRenew: true, status: "expired" } : k)) }),
    expect: ["CONTRACT_EXPIRED"],
  },
  {
    name: "active auto-renewing contract past its end date is still in force",
    ctx: (c) => ({ ...c, contracts: c.contracts.map((k) => (k.id === "C-RATE" ? { ...k, endDate: "2026-06-30", autoRenew: true } : k)) }),
    expect: [],
  },
  {
    name: "invoice before the contract starts",
    ctx: (c) => ({ ...c, contracts: c.contracts.map((k) => (k.id === "C-RATE" ? { ...k, startDate: "2026-11-01" } : k)) }),
    expect: ["CONTRACT_NOT_STARTED"],
  },
  {
    name: "invoice currency differs from the contract",
    input: (i) => ({ ...i, currency: "USD", invoiceDate: "2026-10-09" }),
    expect: ["CONTRACT_CURRENCY_MISMATCH"],
  },

  // ---- fixed monthly fee ----
  { name: "fixed fee billed exactly", input: cloudly([{ d: "Subscription", c: 100000 }]), expect: [] },
  {
    name: "fixed fee billed at a different amount",
    input: cloudly([{ d: "Subscription", c: 109000 }]),
    expect: ["CONTRACT_FIXED_FEE_MISMATCH"],
    check: (_r, f) => expect(f.CONTRACT_FIXED_FEE_MISMATCH!.message).toBe("Billed $1,090.00, but contract C-FIX fixes the monthly fee at $1,000.00 (+9.0%)"),
  },
  {
    name: "usage charged on top of the fixed fee (info)",
    input: cloudly([{ d: "Subscription", c: 100000 }, { d: "Extra storage", c: 12500 }]),
    expect: ["CONTRACT_USAGE_OVERAGE"],
    check: (_r, f) => expect(f.CONTRACT_USAGE_OVERAGE!.message).toBe("$125.00 billed on top of the $1,000.00 fixed monthly fee (contract C-FIX): line 2"),
  },
  {
    name: "fixed fee already billed this month",
    input: cloudly([{ d: "Subscription", c: 100000 }], "2026-10-28"),
    ctx: (c) => ({ ...c, priorInvoices: [prior({ vendorId: "V8", invoiceNumber: "CL-09", invoiceId: "P-CL-09", invoiceDate: "2026-10-03", contractId: "C-FIX" })] }),
    expect: ["CONTRACT_FIXED_FEE_BILLED_TWICE"],
    check: (_r, f) => {
      expect(f.CONTRACT_FIXED_FEE_BILLED_TWICE!.message).toBe("Contract C-FIX is a fixed monthly fee and October 2026 was already billed on CL-09 (2026-10-03, $1,000.00)");
      expect(f.CONTRACT_FIXED_FEE_BILLED_TWICE!.relatedInvoiceId).toBe("P-CL-09");
    },
  },
  {
    name: "last month's fee does not count as billed twice",
    input: cloudly([{ d: "Subscription", c: 100000 }], "2026-10-02"),
    ctx: (c) => ({ ...c, priorInvoices: [prior({ vendorId: "V8", invoiceNumber: "CL-09", invoiceId: "P-CL-09", invoiceDate: "2026-09-30", contractId: "C-FIX" })] }),
    expect: [],
  },

  // ---- hourly rate cap ----
  { name: "hours at the cap are fine", input: lex([{ d: "Legal services - lease review", q: 10, u: 50000 }]), expect: [] },
  {
    name: "hours above the cap",
    input: lex([{ d: "Legal services - lease review", q: 12, u: 61000 }, { d: "Disbursements and filing fees", q: 1, u: 90000 }]),
    expect: ["CONTRACT_RATE_CAP_EXCEEDED"],
    check: (r, f) => {
      expect(r.flags.filter((x) => x.code === "CONTRACT_RATE_CAP_EXCEEDED")).toHaveLength(1);
      expect(f.CONTRACT_RATE_CAP_EXCEEDED!.message).toBe("Line 1: 12 h at $610.00/h exceeds the contract C-HOUR cap of $500.00/h ($1,320.00 over)");
    },
  },
  { name: "a single flat-fee service line is not hourly", input: lex([{ d: "Workshop facilitation", q: 1, u: 510000 }]), expect: [] },
  { name: "'hours' in the description makes it hourly even at quantity 1", input: lex([{ d: "Advisory hours", q: 1, u: 51000 }]), expect: ["CONTRACT_RATE_CAP_EXCEEDED"] },

  // ---- fuel surcharge cap ----
  { name: "fuel surcharge under the cap", input: freight("Fuel surcharge (9.5%)", 14250), expect: [] },
  {
    name: "fuel surcharge printed and computed above the cap",
    input: freight("Fuel surcharge (22%)", 33000),
    expect: ["CONTRACT_FUEL_SURCHARGE_CAP"],
    check: (_r, f) =>
      expect(f.CONTRACT_FUEL_SURCHARGE_CAP!.message).toBe(
        "Fuel surcharge 22% (line 3: $330.00 on $1,500.00 of other charges = 22.00%) exceeds the contract C-RATE cap of 12%; $150.00 over the cap",
      ),
  },
  { name: "fuel surcharge above the cap with no % printed", input: freight("Fuel surcharge", 18100), expect: ["CONTRACT_FUEL_SURCHARGE_CAP"] },
  { name: "fuel surcharge exactly at the cap", input: freight("Fuel surcharge (12%)", 18000), expect: [] },
  { name: "French fuel line is recognised", input: freight("Supplément carburant (15 %)", 22500), expect: ["CONTRACT_FUEL_SURCHARGE_CAP"] },

  // ---- monthly not-to-exceed ----
  {
    name: "month's spend would pass the not-to-exceed",
    ctx: (c) => ({ ...c, priorInvoices: [prior({ invoiceNumber: "NW-0990", invoiceId: "P-NW-0990", invoiceDate: "2026-10-02", subtotalCents: 1_900_000, subtotalCadCents: 1_900_000, totalCents: 2_147_000, totalCadCents: 2_147_000 })] }),
    expect: ["CONTRACT_NTE_EXCEEDED"],
    check: (_r, f) =>
      expect(f.CONTRACT_NTE_EXCEEDED!.message).toBe(
        "October 2026 spend under contract C-RATE would reach $20,500.00 with this invoice ($19,000.00 before it), above the $20,000.00 monthly not-to-exceed",
      ),
  },
  {
    name: "previous month's spend does not count toward this month's cap",
    ctx: (c) => ({ ...c, priorInvoices: [prior({ invoiceNumber: "NW-0990", invoiceId: "P-NW-0990", invoiceDate: "2026-09-28", subtotalCents: 1_900_000, subtotalCadCents: 1_900_000 })] }),
    expect: [],
  },
];
