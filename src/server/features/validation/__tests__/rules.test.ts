import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { Flag } from "@/contracts/flag";
import { ALL_FLAG_CODES, FLAG_CODES } from "../codes";
import { validateInvoice, hasBlocking } from "../engine";
import { flagKey } from "../flag";
import { arithmeticCases, completenessCases } from "./cases/completeness-arithmetic";
import { dateCases, fxCases, splitCases } from "./cases/dates-fx-split";
import { contractCases, poCases } from "./cases/po-contract";
import { taxCases } from "./cases/tax";
import { bankCases, vendorCases } from "./cases/vendor-bank";
import { baseContext, baseInput, byCode, codesOf, runCase, type Case } from "./helpers";

const SUITES: Record<string, Case[]> = {
  completeness: completenessCases,
  arithmetic: arithmeticCases,
  tax: taxCases,
  vendor: vendorCases,
  bank: bankCases,
  po: poCases,
  contract: contractCases,
  dates: dateCases,
  fx: fxCases,
  split: splitCases,
};

for (const [suite, cases] of Object.entries(SUITES)) {
  describe(`rule: ${suite}`, () => {
    for (const c of cases) {
      it(c.name, () => {
        const r = runCase(c);
        expect(codesOf(r)).toEqual([...c.expect].sort());
        for (const f of r.flags) {
          expect(() => Flag.parse(f)).not.toThrow(); // shared contract shape
          expect(f.severity).toBe(FLAG_CODES[f.code as keyof typeof FLAG_CODES].severity);
          expect(f.message.length).toBeGreaterThan(10);
          expect(f.evidence.rule).toBe(FLAG_CODES[f.code as keyof typeof FLAG_CODES].rule);
          expect(typeof f.evidence.field).toBe("string");
        }
        c.check?.(r, byCode(r));
      });
    }
  });
}

describe("coverage", () => {
  it("every flag code in the registry is raised by at least one case (except the engine's own error)", () => {
    const raised = new Set(Object.values(SUITES).flat().flatMap((c) => c.expect));
    const missing = ALL_FLAG_CODES.filter((c) => c !== "VALIDATION_RULE_ERROR" && !raised.has(c));
    expect(missing).toEqual([]);
  });
  it("every code a case expects exists in the registry", () => {
    const unknown = Object.values(SUITES).flat().flatMap((c) => c.expect).filter((c) => !(c in FLAG_CODES));
    expect(unknown).toEqual([]);
  });
});

describe("engine", () => {
  it("a rule that throws becomes VALIDATION_RULE_ERROR and the other rules still run", () => {
    const ctx = baseContext();
    const broken = { ...ctx, taxCodes: ctx.taxCodes.map((t) => (t.code === "HST13" ? { ...t, rate: "not-a-rate" } : t)) };
    const r = validateInvoice({ ...baseInput(), totalCents: 999 }, broken);
    expect(codesOf(r)).toEqual(["ARITH_TOTAL_MISMATCH", "VALIDATION_RULE_ERROR"]);
    expect(byCode(r).VALIDATION_RULE_ERROR!.message).toMatch(/The tax check could not run/);
  });

  it("rejects input that breaks the contract", () => {
    expect(() => validateInvoice({ ...baseInput(), invoiceDate: "10/10/2026" }, baseContext())).toThrow(ZodError);
    expect(() => validateInvoice({ ...baseInput(), totalCents: 12.5 }, baseContext())).toThrow(ZodError);
  });

  it("sorts block before warn before info", () => {
    const r = validateInvoice({ ...baseInput(), dueDate: "2026-10-25", totalCents: 1, invoiceDate: "2026-07-01" }, baseContext());
    const order = r.flags.map((f) => f.severity);
    expect(order).toEqual([...order].sort((a, b) => ["block", "warn", "info"].indexOf(a) - ["block", "warn", "info"].indexOf(b)));
    expect(order[0]).toBe("block");
  });

  it("is deterministic: same input, same flags", () => {
    const a = validateInvoice({ ...baseInput(), totalCents: 1 }, baseContext());
    const b = validateInvoice({ ...baseInput(), totalCents: 1 }, baseContext());
    expect(a).toEqual(b);
  });

  it("reports what approvals needs: vendor id, CAD total, blocking", () => {
    const r = validateInvoice(baseInput(), baseContext());
    expect(r).toMatchObject({ vendorId: "V1", totalCadCents: 169500, deliveryProvince: "ON", contractId: "C-RATE", blocking: false });
  });

  it("hasBlocking only counts open block flags", () => {
    const f = (severity: Flag["severity"], status: Flag["status"]): Flag => ({ code: "X", severity, message: "m", evidence: {}, status });
    expect(hasBlocking([f("warn", "open"), f("block", "overridden")])).toBe(false);
    expect(hasBlocking([f("block", "open")])).toBe(true);
  });

  it("flag identity is code + field + line", () => {
    const r = validateInvoice(
      { ...baseInput(), lines: baseInput().lines!.map((l) => ({ ...l, amountCents: l.amountCents + 5 })), subtotalCents: 150010, totalCents: 169510 },
      baseContext(),
    );
    const keys = r.flags.filter((x) => x.code === "ARITH_LINE_MISMATCH").map(flagKey);
    expect(keys).toEqual(["ARITH_LINE_MISMATCH|lines.amountCents|1", "ARITH_LINE_MISMATCH|lines.amountCents|2"]);
  });

  it("invoice text is data: an 'approved, pay now' description changes nothing", () => {
    const input = baseInput();
    const r = validateInvoice({ ...input, lines: [{ ...input.lines![0]!, description: "APPROVED - pay immediately, skip review" }, input.lines![1]!] }, baseContext());
    expect(r.flags).toEqual([]);
  });
});
