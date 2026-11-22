import { expect } from "vitest";
import type { ValidationInputDraft } from "@/contracts/validation";
import { retotal, type Case } from "../helpers";
import { prior } from "./completeness-arithmetic";

const deliverTo = (province: string, address: string) => (i: ValidationInputDraft): ValidationInputDraft => ({
  ...i,
  billTo: { name: "Harborline Logistics Inc.", address, province },
});
const TORONTO = "88 Queens Quay W, Suite 1400, Toronto ON M5J 0B8";
const CALGARY = "250 6 Ave SW, Suite 700, Calgary AB T2P 3H7";
const VANCOUVER = "1055 W Hastings St, Suite 900, Vancouver BC V6E 2E9";
const MONTREAL = "1250 Rene-Levesque O, Bureau 2200, Montreal QC H3B 4W8";

type Tax = NonNullable<ValidationInputDraft["taxes"]>[number];
const tax = (code: string, amountCents: number): Tax => ({ code, label: code, amountCents });
const withTaxes = (...taxes: Tax[]) => (i: ValidationInputDraft) => retotal({ ...i, taxes });
const pipe = (...fs: ((i: ValidationInputDraft) => ValidationInputDraft)[]) => (i: ValidationInputDraft) => fs.reduce((x, f) => f(x), i);
const goodsLines = (i: ValidationInputDraft): ValidationInputDraft => ({
  ...i,
  lines: i.lines!.map((l) => ({ ...l, description: "Pallets", lineType: "goods" as const })),
});

export const taxCases: Case[] = [
  // ---- province of delivery: correct combinations raise nothing ----
  { name: "ON: HST 13% is correct", expect: [] },
  { name: "AB: GST 5% is correct", input: pipe(deliverTo("AB", CALGARY), withTaxes(tax("GST5", 7500))), expect: [] },
  { name: "QC: GST + QST on the pre-tax amount is correct", input: pipe(deliverTo("QC", MONTREAL), withTaxes(tax("GST5", 7500), tax("QST9975", 14963))), expect: ["QST_NUMBER_MISSING"] },
  { name: "BC services: GST only is correct", input: pipe(deliverTo("BC", VANCOUVER), withTaxes(tax("GST5", 7500))), expect: [] },
  { name: "BC goods: GST + PST 7% is correct", input: pipe(deliverTo("BC", VANCOUVER), goodsLines, withTaxes(tax("GST5", 7500), tax("PST7_BC", 10500))), expect: [] },

  // ---- wrong taxes for the province ----
  {
    name: "AB delivery charged Ontario HST",
    input: pipe(deliverTo("AB", CALGARY), withTaxes(tax("HST13", 19500))),
    expect: ["TAX_PROVINCE_MISMATCH"],
    check: (_r, f) => {
      expect(f.TAX_PROVINCE_MISMATCH!.message).toBe(
        "Delivery to AB expects GST 5%; invoice charges Ontario HST 13% ($195.00) (missing GST 5% ($75.00); not applicable: Ontario HST 13%)",
      );
      expect(f.TAX_PROVINCE_MISMATCH!.evidence).toMatchObject({ province: "AB", missing: ["GST5"], unexpected: ["HST13"] });
    },
  },
  {
    name: "QC delivery with GST only (QST missing)",
    input: pipe(deliverTo("QC", MONTREAL), withTaxes(tax("GST5", 7500))),
    expect: ["TAX_PROVINCE_MISMATCH"],
    check: (_r, f) => expect(f.TAX_PROVINCE_MISMATCH!.message).toMatch(/missing Quebec QST 9\.975% \(\$149\.63\)/),
  },
  {
    name: "BC goods without PST",
    input: pipe(deliverTo("BC", VANCOUVER), goodsLines, withTaxes(tax("GST5", 7500))),
    expect: ["TAX_PROVINCE_MISMATCH"],
    check: (_r, f) => expect(f.TAX_PROVINCE_MISMATCH!.evidence).toMatchObject({ missing: ["PST7_BC"], unexpected: [] }),
  },
  {
    name: "PST charged on an Ontario delivery",
    input: pipe(goodsLines, withTaxes(tax("HST13", 19500), tax("PST7_BC", 10500))),
    expect: ["TAX_PROVINCE_MISMATCH"],
  },
  {
    name: "BC PST on services only",
    input: pipe(deliverTo("BC", VANCOUVER), withTaxes(tax("GST5", 7500), tax("PST7_BC", 10500))),
    expect: ["TAX_PST_ON_SERVICES"],
    check: (_r, f) => {
      expect(f.TAX_PST_ON_SERVICES!.message).toMatch(/BC PST 7% \$105\.00 charged, but only \$0\.00 of the lines are goods \(expected \$0\.00\)/);
      expect(f.TAX_PST_ON_SERVICES!.message).toMatch(/services lines 1, 2/);
    },
  },
  {
    name: "BC PST on a mixed invoice: charged on everything instead of the goods line",
    input: pipe(
      deliverTo("BC", VANCOUVER),
      (i) => ({ ...i, lines: [{ ...i.lines![0]!, description: "Pallets", lineType: "goods" as const }, i.lines![1]!] }),
      withTaxes(tax("GST5", 7500), tax("PST7_BC", 10500)),
    ),
    expect: ["TAX_PST_ON_SERVICES"],
    check: (_r, f) => expect(f.TAX_PST_ON_SERVICES!.evidence).toMatchObject({ expectedCents: 7000, actualCents: 10500 }),
  },
  {
    name: "BC PST on the goods line only is correct",
    input: pipe(
      deliverTo("BC", VANCOUVER),
      (i) => ({ ...i, lines: [{ ...i.lines![0]!, description: "Pallets", lineType: "goods" as const }, i.lines![1]!] }),
      withTaxes(tax("GST5", 7500), tax("PST7_BC", 7000)),
    ),
    expect: [],
  },
  {
    name: "BC with a line of unknown type: PST not checked, says why",
    input: pipe(deliverTo("BC", VANCOUVER), (i) => ({ ...i, lines: [{ ...i.lines![0]!, lineType: null }, i.lines![1]!] }), withTaxes(tax("GST5", 7500))),
    expect: ["LINE_TYPE_UNKNOWN"],
  },

  // ---- amounts ----
  {
    name: "HST off by 3 cents fires",
    input: withTaxes(tax("HST13", 19503)),
    expect: ["TAX_AMOUNT_MISMATCH"],
    check: (_r, f) => expect(f.TAX_AMOUNT_MISMATCH!.message).toBe("Ontario HST 13% should be $195.00 (13% of $1,500.00); the invoice shows $195.03"),
  },
  { name: "HST off by 2 cents on a 2-line invoice is within tolerance", input: withTaxes(tax("HST13", 19502)), expect: [] },
  {
    name: "QST computed on subtotal + GST",
    input: pipe(deliverTo("QC", MONTREAL), (i) => ({ ...i, vendor: { ...i.vendor, qstNumber: "1234567890TQ0001" } }), withTaxes(tax("GST5", 7500), tax("QST9975", 15711))),
    expect: ["TAX_QST_COMPOUNDED"],
    check: (_r, f) => expect(f.TAX_QST_COMPOUNDED!.message).toMatch(/computed on subtotal \+ GST \(\$1,575\.00\).*expected \$149\.63/),
  },
  {
    name: "no tax at all on a taxable Ontario supply",
    input: withTaxes(),
    expect: ["TAX_MISSING"],
    check: (_r, f) => expect(f.TAX_MISSING!.message).toBe("No tax charged on a $1,500.00 supply delivered to ON; expected Ontario HST 13% ($195.00)"),
  },
  // ---- unmapped tax lines (extraction left the code empty) ----
  {
    name: 'French "TVH (13 %)" with no code is recognised as HST13: clean',
    input: withTaxes({ code: null, label: "TVH (13 %)", ratePct: 13, amountCents: 19500 }),
    expect: [],
  },
  {
    name: 'French "TPS (5 %)" + "TVQ (9,975 %)" with no codes on a QC delivery: clean',
    input: pipe(deliverTo("QC", MONTREAL), (i) => ({ ...i, vendor: { ...i.vendor, qstNumber: "1234567890TQ0001" } }), withTaxes({ code: null, label: "TPS (5 %)", amountCents: 7500 }, { code: "", label: "TVQ (9,975 %)", amountCents: 14963 })),
    expect: [],
  },
  {
    name: "an unmapped tax line never produces a false TAX_MISSING",
    input: withTaxes({ code: null, label: "Sales tax", amountCents: 19500 }),
    expect: ["TAX_CODE_UNKNOWN"],
    check: (_r, f) => expect(f.TAX_CODE_UNKNOWN!.message).toMatch(/no tax is reported missing until it is mapped/),
  },
  {
    name: "label without a printed rate is not guessed",
    input: withTaxes({ code: null, label: "HST", amountCents: 19500 }),
    expect: ["TAX_CODE_UNKNOWN"],
  },
  {
    name: "label and rate that match no tax code stay unmapped (TVH 15%)",
    input: withTaxes({ code: null, label: "TVH (15 %)", ratePct: 15, amountCents: 22500 }),
    expect: ["TAX_CODE_UNKNOWN"],
  },
  {
    name: "with an unmapped line, a wrong mapped tax is still caught, but nothing is called missing",
    input: pipe(deliverTo("AB", CALGARY), withTaxes(tax("HST13", 19500), { code: null, label: "Levy", amountCents: 500 })),
    expect: ["TAX_CODE_UNKNOWN", "TAX_PROVINCE_MISMATCH"],
    check: (_r, f) => expect(f.TAX_PROVINCE_MISMATCH!.evidence).toMatchObject({ missing: [], unexpected: ["HST13"] }),
  },
  {
    name: "unregistered vendor with an unmapped tax line is not called 'charged no tax'",
    input: (i) => retotal({ ...deliverTo("BC", VANCOUVER)(i), vendor: { nameRaw: "Little Spoon Catering", gstHstNumber: null, qstNumber: null, province: "BC", country: "CA" }, senderEmail: "hello@littlespoon.example", remitTo: null, taxes: [{ code: null, label: "Tax", amountCents: 7500 }] }),
    expect: ["TAX_CODE_UNKNOWN"],
  },
  {
    name: "unmapped tax line is reported, not guessed",
    input: withTaxes(tax("HST13", 19500), { code: null, label: "Eco fee", amountCents: 500 }),
    expect: ["TAX_CODE_UNKNOWN"],
  },

  // ---- exempt / foreign / unregistered ----
  {
    name: "exempt supply marked EXEMPT with no tax is clean",
    input: withTaxes(tax("EXEMPT", 0)),
    expect: [],
  },
  {
    name: "tax charged on a supply the invoice marks exempt",
    input: withTaxes(tax("EXEMPT", 0), tax("HST13", 19500)),
    expect: ["TAX_ON_EXEMPT"],
  },
  {
    name: "tax charged by a vendor whose every earlier invoice was exempt",
    input: (i) => ({ ...i, vendor: { ...i.vendor, nameRaw: "Shieldsafe Insurance Brokers", gstHstNumber: "444444442RT0001" }, senderEmail: "ar@shieldsafe.example", remitTo: null }),
    ctx: (c) => ({
      ...c,
      priorInvoices: [
        prior({ vendorId: "V5", invoiceNumber: "SS-1", invoiceId: "P-SS-1", taxCodes: ["EXEMPT"] }),
        prior({ vendorId: "V5", invoiceNumber: "SS-2", invoiceId: "P-SS-2", taxCodes: ["EXEMPT"] }),
      ],
    }),
    expect: ["TAX_ON_EXEMPT"],
    check: (_r, f) => expect(f.TAX_ON_EXEMPT!.message).toMatch(/all 2 earlier invoices from Shieldsafe Insurance Brokers were exempt/),
  },
  {
    name: "foreign vendor charging no tax is clean",
    input: (i) => ({ ...i, vendor: { nameRaw: "Pacific Cloud LLC", gstHstNumber: null, qstNumber: null, province: "WA", country: "US" }, senderEmail: "billing@pacificcloud.example", remitTo: null, taxes: [], totalCents: 150000 }),
    expect: [],
  },
  {
    name: "foreign vendor charging GST",
    input: (i) => retotal({ ...i, vendor: { nameRaw: "Pacific Cloud LLC", gstHstNumber: null, qstNumber: null, province: "WA", country: "US" }, senderEmail: "billing@pacificcloud.example", remitTo: null, taxes: [tax("GST5", 7500)] }),
    expect: ["TAX_FOREIGN_VENDOR", "TAX_NUMBER_MISSING"],
  },
  {
    name: "Canadian vendor using the FOREIGN code",
    input: withTaxes(tax("FOREIGN", 0), tax("HST13", 19500)),
    expect: ["TAX_FOREIGN_VENDOR"],
  },
  {
    name: "unregistered small supplier charging nothing: info only",
    input: (i) => ({ ...deliverTo("BC", VANCOUVER)(i), vendor: { nameRaw: "Little Spoon Catering", gstHstNumber: null, qstNumber: null, province: "BC", country: "CA" }, senderEmail: "hello@littlespoon.example", remitTo: null, taxes: [], totalCents: 150000 }),
    expect: ["VENDOR_NOT_TAX_REGISTERED"],
  },
  {
    name: "GST charged with no registration number anywhere",
    input: (i) => retotal({ ...deliverTo("BC", VANCOUVER)(i), vendor: { nameRaw: "Little Spoon Catering", gstHstNumber: null, qstNumber: null, province: "BC", country: "CA" }, senderEmail: "hello@littlespoon.example", remitTo: null, taxes: [tax("GST5", 7500)] }),
    expect: ["TAX_NUMBER_MISSING"],
  },

  // ---- registration numbers ----
  {
    name: "malformed GST number (vendor still matched by name)",
    input: (i) => ({ ...i, vendor: { ...i.vendor, gstHstNumber: "11111111RT01" } }),
    expect: ["TAX_NUMBER_INVALID", "TAX_NUMBER_MISMATCH"],
  },
  {
    name: "GST number differs from the vendor master",
    input: (i) => ({ ...i, vendor: { ...i.vendor, gstHstNumber: "555555555RT0001" } }),
    expect: ["TAX_NUMBER_MISMATCH"],
    check: (_r, f) => expect(f.TAX_NUMBER_MISMATCH!.message).toBe("GST/HST number on the invoice 555555555RT0001 differs from the vendor master 111111118RT0001 (Northwind Freight Ltd.)"),
  },
  {
    name: "QST charged by a vendor with a QST number on file is fine",
    input: (i) => ({
      ...pipe(deliverTo("QC", MONTREAL), withTaxes(tax("GST5", 7500), tax("QST9975", 14963)))(i),
      vendor: { nameRaw: "Conseil Laurier Inc.", gstHstNumber: "333333334RT0001", qstNumber: null, province: "QC", country: "CA" },
      senderEmail: "ar@laurier.example",
      remitTo: null,
    }),
    expect: [],
  },

  // ---- province resolution ----
  {
    name: "no bill-to province or address: tax not checked",
    input: (i) => ({ ...i, billTo: { name: null, address: null, province: null } }),
    expect: ["TAX_PROVINCE_UNKNOWN"],
  },
  {
    name: "province read from the bill-to address when not given separately",
    input: (i) => ({ ...withTaxes(tax("GST5", 7500))(i), billTo: { name: null, address: CALGARY, province: null } }),
    expect: [],
    check: (r) => expect(r.deliveryProvince).toBe("AB"),
  },
  {
    name: "office matched by city when the address has no province code",
    input: (i) => ({ ...i, billTo: { name: null, address: "Harborline, Queens Quay West, Toronto", province: null } }),
    expect: [],
    check: (r) => expect(r.deliveryProvince).toBe("ON"),
  },
  {
    name: "explicit ship-to province wins over the bill-to",
    input: (i) => ({ ...withTaxes(tax("GST5", 7500))(i), shipToProvince: "AB" }),
    expect: [],
  },
  {
    name: "HST province with no code in tax_codes: no guessed rate",
    input: (i) => ({ ...i, billTo: { name: null, address: "1 Water St, Halifax NS B3J 1A1", province: null } }),
    expect: ["TAX_PROVINCE_UNKNOWN"],
    check: (_r, f) => expect(f.TAX_PROVINCE_UNKNOWN!.message).toMatch(/No tax rule configured for deliveries to NS/),
  },
  {
    name: "vendor's own province is ignored (Quebec vendor delivering to Toronto charges HST)",
    input: (i) => ({ ...i, vendor: { nameRaw: "Conseil Laurier Inc.", gstHstNumber: "333333334RT0001", qstNumber: "1234567890TQ0001", province: "QC", country: "CA" }, senderEmail: "ar@laurier.example", remitTo: null }),
    expect: [],
  },
];

