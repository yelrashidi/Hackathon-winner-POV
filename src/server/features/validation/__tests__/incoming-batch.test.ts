import { describe, expect, it } from "vitest";
import { ValidationInput } from "@/contracts/validation";
import { loadIncomingFixtures, validateBatch } from "../dataset/batch";
import { loadDatasetContext } from "../dataset/load-context";

/**
 * The real incoming batch (56 invoices: 54 PDFs + 2 scans) as clean extraction output, checked
 * against the Harborline dataset. Each fixture's `expectedCodes` was written by hand from reading
 * the document and the reference data, before the rules existed — so a pass means the engine
 * agrees with an independent reading, and a code that appears or disappears fails loudly.
 */
const fixtures = loadIncomingFixtures();
const ctx = loadDatasetContext();
const results = validateBatch(fixtures.map((f) => f.fixture.input), ctx);
const byFile = new Map(fixtures.map((f, i) => [f.file, { fixture: f.fixture, result: results[i]! }]));
const get = (file: string) => {
  const hit = byFile.get(file);
  if (!hit) throw new Error(`no fixture ${file}`);
  return hit;
};
const flag = (file: string, code: string) => get(file).result.flags.find((f) => f.code === code);

describe("incoming batch fixtures", () => {
  it("there are 56 and each satisfies the ValidationInput contract", () => {
    expect(fixtures).toHaveLength(56);
    for (const { fixture } of fixtures) expect(() => ValidationInput.parse(fixture.input)).not.toThrow();
  });

  for (const { file, fixture } of fixtures) {
    it(`${file}: ${fixture.expectedCodes?.join(", ") || "clean"}`, () => {
      const codes = [...new Set(get(file).result.flags.map((f) => f.code))].sort();
      expect(codes).toEqual([...(fixture.expectedCodes ?? [])].sort());
    });
  }
});

describe("incoming batch: the messages carry the real numbers", () => {
  it("fuel surcharge over the contract cap", () => {
    expect(flag("invoice-000964.json", "CONTRACT_FUEL_SURCHARGE_CAP")!.message).toBe(
      "Fuel surcharge 22% (line 4: $489.49 on $2,318.29 of other charges = 21.11%) exceeds the contract C018 cap of 12%; $211.30 over the cap",
    );
  });
  it("tax charged for the wrong province", () => {
    expect(flag("northboundcourie-000639.json", "TAX_PROVINCE_MISMATCH")!.message).toBe(
      "Delivery to AB expects GST 5%; invoice charges Ontario HST 13% ($288.25) (missing GST 5% ($110.86); not applicable: Ontario HST 13%)",
    );
    expect(flag("beaumontrivieres-fa000557.json", "TAX_PROVINCE_MISMATCH")!.message).toMatch(/Delivery to QC expects GST 5% \+ Quebec QST 9\.975%; invoice charges GST 5% \(\$385\.79\) \(missing Quebec QST 9\.975% \(\$769\.66\)\)/);
  });
  it("arithmetic errors", () => {
    expect(flag("northstarmediabu-no261773.json", "ARITH_LINE_MISMATCH")!.message).toBe("Line 1: 24 × $150.00 = $3,600.00, but the line shows $3,800.00");
    expect(flag("evergreenenergyu-000850.json", "ARITH_TOTAL_MISMATCH")!.message).toBe("$3,180.00 + $159.00 = $3,339.00, but the total shows $3,439.00");
  });
  it("split invoices hand approvals the combined CAD total", () => {
    for (const f of ["invoice-287.json", "orionstrategypar-281.json", "orionstrategypar-inv-029.json"]) {
      expect(flag(f, "SPLIT_INVOICE_SUSPECTED")!.evidence).toMatchObject({ combinedCadCents: 1_454_310, thresholdCadCents: 1_000_000 });
    }
  });
  it("unverified bank change on both Cascadia invoices", () => {
    for (const f of ["cascadiacartagel-1625.json", "scan-8049.json"]) {
      expect(flag(f, "BANK_ACCOUNT_UNVERIFIED")!.message).toBe(
        "Remit-to account ••9679 is the bank change requested 2026-10-27 by email request and not yet verified by a second person (verified account on file: ••7504)",
      );
    }
  });
  it("lookalike vendor record", () => {
    expect(get("invoice-ha26-2766.json").result.vendorId).toBe("V052");
    expect(flag("invoice-ha26-2766.json", "VENDOR_LOOKALIKE")!.message).toMatch(/Harlow and Stern LLP \(V052, 0 invoices on record\) resembles Harlow & Stern LLP \(V026, 4 invoices\): name 100% similar/);
  });
  it("the real vendors behind lookalike records are matched and not flagged", () => {
    expect(get("invoice-000964.json").result.vendorId).toBe("V001");
    expect(get("greatlakescarrie-inv-016.json").result.vendorId).toBe("V002");
    expect(get("harlowsternllp-001468.json").result.vendorId).toBe("V026");
  });
  it("USD invoices are converted at the invoice-date rate", () => {
    expect(get("sparkgridcrminc-fa002342.json").result).toMatchObject({ fxRate: expect.any(String), totalCadCents: expect.any(Number) });
    expect(get("sparkgridcrminc-fa002342.json").result.totalCadCents).toBeGreaterThan(195000);
  });
  it("PO-required invoices point the clerk at an open PO when one exists", () => {
    expect(flag("ironwoodpalletco-inv-048.json", "PO_REQUIRED_MISSING")!.message).toMatch(/PO-2026-0051 \(\$1,007\.20 remaining\)/);
    expect(flag("invoice-853.json", "PO_REQUIRED_MISSING")!.message).toMatch(/No open PO for this vendor/);
  });
  it("nothing in the batch crashes a rule", () => {
    expect(results.flatMap((r) => r.flags).filter((f) => f.code === "VALIDATION_RULE_ERROR")).toEqual([]);
  });
});
