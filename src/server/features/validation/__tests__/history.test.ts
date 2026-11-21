import { describe, expect, it } from "vitest";
import { historicalInputs } from "../dataset/history";
import { loadDatasetContext, readDatasetTables } from "../dataset/load-context";
import { validateInvoice } from "../engine";

/**
 * False-positive budget: the 426 historical invoices, each checked against all the others.
 * These are expected hits measured on the dataset — they lock the behaviour, they are never
 * constants in logic (CLAUDE.md rule 4). A new rule that adds noise here fails this test.
 */
const tables = readDatasetTables();
// POs carry today's status (closed after these invoices used them), so replay them as open.
const ctx = loadDatasetContext({ ...tables, purchaseOrders: tables.purchaseOrders.map((p) => ({ ...p, status: "open" })) });
const results = historicalInputs(tables).map((i) => validateInvoice(i, ctx));
const withCode = (code: string) => results.filter((r) => r.flags.some((f) => f.code === code)).map((r) => r.invoiceId).sort();

describe("history replay (false-positive budget)", () => {
  it("replays all 426 invoices without a rule error", () => {
    expect(results).toHaveLength(426);
    expect(withCode("VALIDATION_RULE_ERROR")).toEqual([]);
  });

  it("blocks only the three historical tax errors", () => {
    const blocked = results.filter((r) => r.blocking).map((r) => r.invoiceId).sort();
    expect(blocked).toEqual(["AP-00098", "AP-00253", "AP-00325"]);
    expect(withCode("TAX_PROVINCE_MISMATCH")).toEqual(["AP-00098", "AP-00253"]); // QC without QST; AB charged HST
    expect(withCode("TAX_MISSING")).toEqual(["AP-00325"]); // ON with no tax
  });

  it("no arithmetic flags: the history is internally consistent", () => {
    for (const code of ["ARITH_LINE_MISMATCH", "ARITH_SUBTOTAL_MISMATCH", "ARITH_TOTAL_MISMATCH", "TAX_AMOUNT_MISMATCH"]) expect(withCode(code)).toEqual([]);
  });

  it("finds the planted history mess", () => {
    expect(withCode("PO_OVER_BALANCE")).toEqual(["AP-00159", "AP-00216"]);
    expect(withCode("PO_REQUIRED_MISSING")).toEqual(["AP-00200", "AP-00206", "AP-00207"]);
    expect(withCode("CONTRACT_EXPIRED")).toEqual(["AP-00274", "AP-00363", "AP-00379"]);
    expect(withCode("CONTRACT_FIXED_FEE_MISMATCH")).toEqual(["AP-00287", "AP-00334", "AP-00372"]);
    expect(withCode("CONTRACT_NTE_EXCEEDED")).toEqual(["AP-00072", "AP-00075", "AP-00136", "AP-00155", "AP-00228", "AP-00234"]);
    expect(withCode("VENDOR_NOT_ACTIVE")).toEqual(["AP-00109", "AP-00292"]); // on-hold lookalike V053
    expect(withCode("VENDOR_LOOKALIKE")).toEqual(["AP-00109", "AP-00112", "AP-00122", "AP-00212", "AP-00292"]); // V051, V053 only
  });

  it("split detection: the orders in parts, the phased repair, the two-part campaign and a same-day pair", () => {
    expect(withCode("SPLIT_INVOICE_SUSPECTED")).toEqual(["AP-00120", "AP-00129", "AP-00131", "AP-00136", "AP-00155", "AP-00200", "AP-00206", "AP-00207", "AP-00303", "AP-00304"]);
    for (const r of results) {
      const s = r.flags.find((f) => f.code === "SPLIT_INVOICE_SUSPECTED");
      if (s) expect(Number.isInteger(s.evidence.combinedCadCents)).toBe(true);
    }
  });
});
