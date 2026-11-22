import { describe, expect, it } from "vitest";
import { CodingResult } from "@/contracts/coding";
import { matchVendor } from "@/server/features/validation";
import { suggestCoding } from "..";
import { incomingInvoices, loadCodingContext, vendorRefs } from "./dataset";

/**
 * The 56 unprocessed invoices, as the analysis pass will run them: validation's matchVendor
 * resolves the vendor, coding codes the lines. Cross-checked against validation's own expected
 * flags for the same invoices (fixtures/validation/incoming).
 */
const ctx = loadCodingContext();
const refs = vendorRefs();
const batch = incomingInvoices().map(({ file, input, expectedCodes }) => {
  const match = matchVendor({ vendor: { nameRaw: null, gstHstNumber: null, qstNumber: null, province: null, country: null, ...input.vendor }, senderEmail: input.senderEmail ?? null }, refs);
  return { file, expectedCodes, vendorId: match.vendor?.id ?? null, result: suggestCoding(input, match.vendor?.id ?? null, ctx) };
});
const byFile = (file: string) => {
  const found = batch.find((b) => b.file === file);
  if (!found) throw new Error(`no incoming invoice ${file}`);
  return found;
};

describe("the incoming batch", () => {
  it("codes all 56 invoices without throwing, within the contract", () => {
    expect(batch).toHaveLength(56);
    for (const b of batch) expect(() => CodingResult.parse(b.result)).not.toThrow();
  });

  it("suggests an account for every line, and is honest about the weak ones", () => {
    expect(batch.flatMap((b) => b.result.lines.filter((l) => !l.account.value))).toEqual([]);
    // Unknown vendor, "Data migration services": only the word "data" is known → a low-confidence guess.
    expect(byFile("zephyrdataservic-7590.json").result.lines[0]!.account).toMatchObject({ confidence: "low", basis: "description_similarity" });
  });

  it.each([
    ["fuel surcharge on a freight invoice → freight", "invoice-000961.json", 6, "5010", null],
    ["French rent (Loyer de base)", "placemontroyalim-inv-053.json", 1, "6610", null],
    ["French operating costs (Frais d'exploitation)", "placemontroyalim-inv-053.json", 2, "6610", null],
    ["credit note → coding of invoice GR26-2262", "greatlakescarrie-inv-025.json", 1, "5010", "credit_note_original"],
    ["unknown courier → freight from similar lines", "invoice-4443.json", 1, "5010", "description_similarity"],
    ["vendor with no history → its default account", "riverbendcaterin-1739.json", 1, "6720", "vendor_default"],
    ["lookalike vendor record with no history → its default", "invoice-ha26-2766.json", 1, "6310", "vendor_default"],
    ["racking vendor's pallets → packaging", "keystonerackings-inv-002.json", 1, "5040", null],
    ["racking vendor's stretch wrap → packaging (as everywhere else)", "keystonerackings-inv-002.json", 2, "5040", "description_similarity"],
  ])("%s", (_n, file, lineNo, gl, basis) => {
    const l = byFile(file).result.lines.find((x) => x.lineNo === lineNo)!;
    expect(l.account.value).toBe(gl);
    if (basis) expect(l.account.basis).toBe(basis);
  });

  it("knows when it does not know the department (no requester on any incoming invoice)", () => {
    expect(byFile("invoice-853.json").result.flags.map((f) => f.code)).toContain("CODING_DEPARTMENT_UNCERTAIN"); // safety vendor billing two departments
    expect(byFile("invoice-ha26-2766.json").result.invoiceDepartment.value).toBeNull();
    expect(byFile("invoice-fa-002853.json").result.invoiceDepartment).toMatchObject({ value: "D05", confidence: "high" }); // internet → IT, always
  });

  it("the journal balances for every invoice whose arithmetic validation accepts", () => {
    for (const b of batch) {
      if (!b.result.journal.balanced) expect(b.expectedCodes.some((c) => c.startsWith("ARITH_")), `${b.file} is unbalanced but validation expects ${b.expectedCodes}`).toBe(true);
    }
    expect(batch.filter((b) => b.result.journal.balanced).length).toBeGreaterThanOrEqual(54);
  });

  it("routes recoverable tax to the receivable accounts and never to an expense", () => {
    const alpenglow = byFile("alpengloweventsc-inv-010.json").result.journal.debits.filter((d) => d.kind === "recoverable_tax");
    expect(alpenglow.map((d) => d.glAccount)).toEqual(["1160", "1165"]); // QC: GST + QST
    for (const b of batch) {
      for (const d of b.result.journal.debits) if (d.kind === "recoverable_tax") expect(["1160", "1165"]).toContain(d.glAccount);
    }
  });
});
