import { describe, expect, it } from "vitest";
import { Flag } from "../flag";
import { ValidationInput } from "../validation";

const minimalInvoice = () => ({ invoiceId: "CONTRACT-1", vendor: {}, receivedDate: "2026-11-21" });

describe("extraction to validation contract", () => {
  it("accepts a partial extraction so validation can flag missing fields", () => {
    expect(ValidationInput.parse(minimalInvoice())).toMatchObject({
      documentType: "invoice", vendor: { nameRaw: null, gstHstNumber: null },
      invoiceDate: null, currency: null, lines: [], taxes: [], totalCents: null, confidence: {},
    });
  });

  it("normalizes blank extracted fields and trims values", () => {
    expect(ValidationInput.parse({ ...minimalInvoice(), invoiceNumber: "  INV-1  ", invoiceDate: " ",
      dueDate: "", currency: " CAD ", vendor: { nameRaw: "  " } })).toMatchObject({
      invoiceNumber: "INV-1", invoiceDate: null, dueDate: null, currency: "CAD", vendor: { nameRaw: null },
    });
  });

  it.each([1.5, Infinity, NaN, "100"])("rejects non-integer money: %s", (totalCents) => {
    expect(ValidationInput.safeParse({ ...minimalInvoice(), totalCents }).success).toBe(false);
  });

  it("preserves signed credit-note amounts", () => {
    expect(ValidationInput.parse({ ...minimalInvoice(), documentType: "credit_note", totalCents: -11300 }).totalCents).toBe(-11300);
  });

  it.each([-0.01, 1.01])("rejects confidence outside 0..1: %s", (confidence) => {
    expect(ValidationInput.safeParse({ ...minimalInvoice(), confidence: { totalCents: confidence } }).success).toBe(false);
  });

  it("rejects non-ISO dates but leaves calendar validation to the engine", () => {
    expect(ValidationInput.safeParse({ ...minimalInvoice(), invoiceDate: "11/21/2026" }).success).toBe(false);
    expect(ValidationInput.safeParse({ ...minimalInvoice(), invoiceDate: "2026-02-30" }).success).toBe(true);
  });
});

describe("shared flag contract", () => {
  const flag = { code: "PO_OVER_BALANCE", severity: "warn", message: "Subtotal exceeds the PO balance" };

  it("defaults new flags to open and retains approval routing evidence", () => {
    expect(Flag.parse({ ...flag, evidence: { combinedCadCents: 1200000 }, relatedInvoiceId: "INV-2" })).toEqual({
      ...flag, evidence: { combinedCadCents: 1200000 }, relatedInvoiceId: "INV-2", status: "open",
    });
    expect(Flag.parse(flag).evidence).toEqual({});
  });

  it.each([
    { code: "bad-code" }, { severity: "critical" }, { status: "ignored" }, { message: "" },
  ])("rejects incompatible flag fields: %j", (invalid) => {
    expect(Flag.safeParse({ ...flag, ...invalid }).success).toBe(false);
  });

  it.each(["resolved", "overridden"])("retains historical flag status: %s", (status) => {
    expect(Flag.parse({ ...flag, status }).status).toBe(status);
  });
});
