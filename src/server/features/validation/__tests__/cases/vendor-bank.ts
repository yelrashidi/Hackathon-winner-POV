import { expect } from "vitest";
import type { ValidationContext } from "../../context";
import { vendor, type Case } from "../helpers";

const addVendors = (...vs: ReturnType<typeof vendor>[]) => (c: ValidationContext): ValidationContext => ({ ...c, vendors: [...c.vendors, ...vs] });

export const vendorCases: Case[] = [
  {
    name: "unknown vendor, with the closest names offered as candidates",
    input: (i) => ({ ...i, vendor: { ...i.vendor, nameRaw: "Northwind Freight Services", gstHstNumber: "777777777RT0001" }, senderEmail: "ar@nwfs.example", remitTo: null }),
    expect: ["VENDOR_UNKNOWN"],
    check: (r, f) => {
      expect(r.vendorId).toBeNull();
      expect(f.VENDOR_UNKNOWN!.message).toMatch(/"Northwind Freight Services" is not in the vendor master/);
      expect(f.VENDOR_UNKNOWN!.message).toMatch(/Closest in the vendor master: Northwind Freight Ltd\. \(V1, \d+% similar\)/);
    },
  },
  {
    name: "vendor pending review",
    ctx: (c) => ({ ...c, vendors: c.vendors.map((v) => (v.id === "V1" ? { ...v, status: "pending_review" } : v)) }),
    expect: ["VENDOR_NOT_ACTIVE"],
    check: (_r, f) => expect(f.VENDOR_NOT_ACTIVE!.message).toBe("Vendor Northwind Freight Ltd. (V1) is pending review — approvals adds a finance-manager review"),
  },
  {
    name: "vendor on hold",
    ctx: (c) => ({ ...c, vendors: c.vendors.map((v) => (v.id === "V1" ? { ...v, status: "on_hold" } : v)) }),
    expect: ["VENDOR_NOT_ACTIVE"],
    check: (_r, f) => expect(f.VENDOR_NOT_ACTIVE!.message).toMatch(/is on hold — approvals holds the invoice/),
  },
  {
    name: "lookalike record: near-identical name to a more established vendor",
    input: (i) => ({ ...i, vendor: { ...i.vendor, nameRaw: "Northwind Freight Limited", gstHstNumber: "123456789RT0001" }, senderEmail: "billing@northwind-freight.example", remitTo: null }),
    ctx: addVendors(vendor({ id: "V60", legalName: "Northwind Freight Limited", gstHstNumber: "123456789RT0001", contactEmail: "billing@northwind-freight.example", invoiceCount: 0 })),
    expect: ["VENDOR_LOOKALIKE"],
    check: (r, f) => {
      expect(r.vendorId).toBe("V60");
      expect(f.VENDOR_LOOKALIKE!.message).toMatch(/Northwind Freight Limited \(V60, 0 invoices on record\) resembles Northwind Freight Ltd\. \(V1, 10 invoices\): name 100% similar/);
    },
  },
  {
    name: "lookalike record: same bank account as an established vendor",
    input: (i) => ({ ...i, vendor: { ...i.vendor, nameRaw: "Zed Haulage", gstHstNumber: "123456789RT0001" }, senderEmail: "ar@zedhaulage.example", remitTo: null }),
    ctx: (c) => ({
      ...addVendors(vendor({ id: "V61", legalName: "Zed Haulage", gstHstNumber: "123456789RT0001", contactEmail: "ar@zedhaulage.example", invoiceCount: 1 }))(c),
      bankAccounts: [...c.bankAccounts, { vendorId: "V61", version: 1, status: "verified", institution: "001", transit: "12345", account: "1234567", last4: "4567", changedAt: null, channel: null }],
    }),
    expect: ["VENDOR_LOOKALIKE"],
    check: (_r, f) => expect(f.VENDOR_LOOKALIKE!.message).toMatch(/same bank account ••4567/),
  },
  {
    name: "the established original is not flagged because a copy exists",
    ctx: addVendors(vendor({ id: "V60", legalName: "Northwind Freight Limited", contactEmail: "ar@northwind.example", invoiceCount: 2 })),
    expect: [],
  },
  {
    name: "lookalike sender domain (one character off a known vendor's domain)",
    input: (i) => ({ ...i, senderEmail: "ar@northwlnd.example" }),
    expect: ["VENDOR_LOOKALIKE"],
    check: (_r, f) => expect(f.VENDOR_LOOKALIKE!.message).toBe("Sent from northwlnd.example, 1 character away from Northwind Freight Ltd.'s domain northwind.example — possible lookalike sender; confirm before paying"),
  },
  {
    name: "matched by tax number, printed name differs",
    input: (i) => ({ ...i, vendor: { ...i.vendor, nameRaw: "Northwind" } }),
    expect: ["VENDOR_NAME_MISMATCH"],
    check: (r) => expect(r.vendorMatch.method).toBe("tax_number"),
  },
  {
    name: "matched by sender domain when name and tax number are missing",
    input: (i) => ({ ...i, vendor: { ...i.vendor, nameRaw: "NW Freight", gstHstNumber: null } }),
    expect: ["VENDOR_NAME_MISMATCH"],
    check: (r) => {
      expect(r.vendorId).toBe("V1");
      expect(r.vendorMatch.method).toBe("email_domain");
    },
  },
  {
    name: "matched by the 9-digit business number root (different program account)",
    input: (i) => ({ ...i, vendor: { ...i.vendor, gstHstNumber: "111111118RT0002" } }),
    expect: ["TAX_NUMBER_MISMATCH"],
    check: (r) => expect(r.vendorId).toBe("V1"),
  },
  {
    name: "name matching ignores punctuation (Ltd. = Ltd) but not & vs and",
    input: (i) => ({ ...i, vendor: { ...i.vendor, nameRaw: "NORTHWIND FREIGHT LTD", gstHstNumber: null }, senderEmail: null }),
    expect: [],
    check: (r) => expect(r.vendorMatch.method).toBe("name"),
  },
];

export const bankCases: Case[] = [
  {
    name: "remit-to is an unverified (pending) bank change",
    input: (i) => ({ ...i, remitTo: { institution: "009", transit: "99999", account: "7654321" } }),
    ctx: (c) => ({
      ...c,
      bankAccounts: [
        { vendorId: "V1", version: 1, status: "verified", institution: null, transit: null, account: null, last4: "4567", changedAt: null, channel: null },
        { vendorId: "V1", version: 2, status: "pending", institution: "009", transit: "99999", account: "7654321", last4: "4321", changedAt: "2026-10-05", channel: "email_request" },
      ],
    }),
    expect: ["BANK_ACCOUNT_UNVERIFIED"],
    check: (_r, f) =>
      expect(f.BANK_ACCOUNT_UNVERIFIED!.message).toBe(
        "Remit-to account ••4321 is the bank change requested 2026-10-05 by email request and not yet verified by a second person (verified account on file: ••4567)",
      ),
  },
  {
    name: "remit-to differs from the verified account",
    input: (i) => ({ ...i, remitTo: { institution: "001", transit: "12345", account: "9999999" } }),
    expect: ["BANK_DETAILS_MISMATCH"],
    check: (_r, f) => expect(f.BANK_DETAILS_MISMATCH!.message).toMatch(/Remit-to account ••9999 \(inst 001, transit 12345\) differs from Northwind Freight Ltd\.'s verified account ••4567/),
  },
  {
    name: "same account number at another transit is a mismatch",
    input: (i) => ({ ...i, remitTo: { institution: "001", transit: "54321", account: "1234567" } }),
    expect: ["BANK_DETAILS_MISMATCH"],
  },
  {
    name: "remit-to account but no verified account on file",
    input: (i) => ({ ...i, vendor: { ...i.vendor, nameRaw: "Cloudly Software Inc.", gstHstNumber: "888888884RT0001" }, senderEmail: "ar@cloudly.example", remitTo: { institution: "003", transit: "33333", account: "3333333" }, invoiceNumber: "CL-1", lines: [{ lineNo: 1, description: "Subscription", quantity: 1, unitPriceCents: 100000, amountCents: 100000, lineType: "services" }], subtotalCents: 100000, taxes: [{ code: "HST13", label: "HST", amountCents: 13000 }], totalCents: 113000 }),
    expect: ["BANK_DETAILS_MISMATCH"],
    check: (_r, f) => expect(f.BANK_DETAILS_MISMATCH!.message).toMatch(/has no verified bank account on file/),
  },
  {
    name: "verified change 10 days before the invoice",
    ctx: (c) => ({ ...c, bankAccounts: c.bankAccounts.map((a) => (a.vendorId === "V1" ? { ...a, changedAt: "2026-09-30", channel: "phone_callback_verified" } : a)) }),
    expect: ["BANK_RECENTLY_CHANGED"],
    check: (_r, f) => expect(f.BANK_RECENTLY_CHANGED!.message).toBe("Northwind Freight Ltd.'s bank account changed 10 days before this invoice (2026-09-30, phone callback verified)"),
  },
  {
    name: "verified change 31 days before the invoice is not recent",
    ctx: (c) => ({ ...c, bankAccounts: c.bankAccounts.map((a) => (a.vendorId === "V1" ? { ...a, changedAt: "2026-09-09" } : a)) }),
    expect: [],
  },
  {
    name: "old version known only by last 4 digits still matches",
    input: (i) => ({ ...i, remitTo: { institution: null, transit: null, account: "000004567" } }),
    ctx: (c) => ({ ...c, bankAccounts: [{ vendorId: "V1", version: 1, status: "verified", institution: null, transit: null, account: null, last4: "4567", changedAt: null, channel: null }] }),
    expect: [],
  },
  { name: "card-paid invoice with no remit-to raises nothing", input: (i) => ({ ...i, remitTo: null }), expect: [] },
];
