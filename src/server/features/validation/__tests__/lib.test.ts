import { describe, expect, it } from "vitest";
import { addDays, daysBetween, isRealDate, monthLabel } from "../lib/dates";
import { inferTaxCode } from "../tax-expectations";
import { baseContext } from "./helpers";
import { rateFor, toCadCents } from "../lib/fx";
import { comparePercent, formatMoney, formatRateAsPercent, mulPercent, mulQty, mulRate, parseMoneyToCents, percentForDisplay } from "../lib/money";
import { coreName, editDistance, emailDomain, lightName, normalizeInvoiceNumber, trigramSimilarity } from "../lib/text";
import { sameInvoiceNumber } from "../derive";

describe("money: integer cents, one rounding, half away from zero", () => {
  it.each([
    [514500, "0.13", 66885],
    [150000, "0.09975", 14963], // 14962.5 → 14963
    [-142850, "0.13", -18571], // -18570.5 → -18571 (credit note rounds like the invoice)
    [134070, "0.05", 6704], // 6703.5 → 6704
    [1, "0.05", 0],
    [10, "0.05", 1], // 0.5 → 1
    [0, "0.13", 0],
  ])("mulRate(%i, %s) = %i", (cents, rate, want) => expect(mulRate(cents, rate)).toBe(want));

  it("never uses float money: 0.1 + 0.2 style inputs stay exact", () => {
    expect(mulRate(10, "0.3")).toBe(3);
    expect(mulRate(33333333333, "0.07")).toBe(2333333333); // large amounts stay exact
  });

  it("quantity × unit price", () => {
    expect(mulQty(2.5, 41999)).toBe(104998);
    expect(mulQty(24, 15000)).toBe(360000);
    expect(mulQty(0.333, 300)).toBe(100);
  });

  it("percent of cents and exact percent comparison", () => {
    expect(mulPercent(150000, "12")).toBe(18000);
    expect(comparePercent(18000, 150000, "12")).toBe(0);
    expect(comparePercent(18001, 150000, "12")).toBe(1);
    expect(comparePercent(-18001, -150000, "12")).toBe(1);
    expect(percentForDisplay(48949, 222497)).toBe("22.00%");
  });

  it.each([
    ["$1,234.56", 123456],
    ["-$1,042.76", -104276],
    ["1 014,18 $", 101418],
    ["2 260,00 $", 226000],
    ["4 362,67 $", 436267],
    ["$1,234", 123400],
    ["3462.86", 346286],
    ["(45.00)", -4500],
    ["1,950.00 USD", 195000],
  ])("parseMoneyToCents(%s) = %i", (text, want) => expect(parseMoneyToCents(text)).toBe(want));

  it("rejects text that is not an amount", () => expect(() => parseMoneyToCents("abc")).toThrow());

  it("formats", () => {
    expect(formatMoney(123456)).toBe("$1,234.56");
    expect(formatMoney(-161421)).toBe("-$1,614.21");
    expect(formatMoney(195000, "USD")).toBe("$1,950.00 USD");
    expect(formatMoney(5)).toBe("$0.05");
    expect(formatRateAsPercent("0.09975")).toBe("9.975%");
    expect(formatRateAsPercent("0.13")).toBe("13%");
  });
});

describe("text", () => {
  it("normalises invoice numbers", () => {
    expect(normalizeInvoiceNumber("ST-4471")).toBe("ST4471");
    expect(normalizeInvoiceNumber(" st 4471 ")).toBe("ST4471");
  });
  it("near-same invoice numbers (duplicates are kept out of sums)", () => {
    expect(sameInvoiceNumber("000903", "000903-A")).toBe(true);
    expect(sameInvoiceNumber("ST-4471", "ST4471")).toBe(true);
    expect(sameInvoiceNumber("279", "2791")).toBe(false); // too short to call a near-match
    expect(sameInvoiceNumber("INV-01567", "INV-01568")).toBe(false);
  });
  it("light names: punctuation and accents, but & is not 'and'", () => {
    expect(lightName("Beaumont Rivière S.E.N.C.R.L.")).toBe("beaumont riviere sencrl");
    expect(lightName("Harlow & Stern LLP")).not.toBe(lightName("Harlow and Stern LLP"));
  });
  it("core names drop legal suffixes and treat & as 'and'", () => {
    expect(coreName("Harlow & Stern LLP")).toBe("harlow and stern");
    expect(coreName("Polar Freight Lines Limited")).toBe(coreName("Polar Freight Lines Ltd."));
  });
  it("trigram similarity (pg_trgm style)", () => {
    expect(trigramSimilarity("great lakes carriers", "great lakes carriers")).toBe(1);
    expect(trigramSimilarity("great lakes carriers", "prairie natural gas utility")).toBeLessThan(0.2);
    expect(trigramSimilarity("", "")).toBe(0);
  });
  it("edit distance and email domains", () => {
    expect(editDistance("speedytires.com", "speedytlres.com")).toBe(1);
    expect(editDistance("abc", "abc")).toBe(0);
    expect(emailDomain("AR@PolarFreight.Example")).toBe("polarfreight.example");
    expect(emailDomain("not-an-email")).toBeNull();
  });
});

describe("dates and fx", () => {
  it("days between and month labels", () => {
    expect(daysBetween("2026-04-06", "2026-11-02")).toBe(210);
    expect(daysBetween("2026-11-27", "2026-11-02")).toBe(-25);
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(monthLabel("2026-10")).toBe("October 2026");
  });
  it("only real calendar days are dates; impossible ones never roll over", () => {
    expect(isRealDate("2026-02-28")).toBe(true);
    expect(isRealDate("2028-02-29")).toBe(true);
    expect(isRealDate("2026-02-29")).toBe(false);
    expect(isRealDate("2026-02-30")).toBe(false);
    expect(isRealDate("2026-13-01")).toBe(false);
    expect(isRealDate("2026-00-10")).toBe(false);
    expect(isRealDate("26-02-01")).toBe(false);
    expect(() => daysBetween("2026-02-30", "2026-03-02")).toThrow(/Not a real calendar date/);
  });
  it("rate for a date: same day, else nearest earlier within the lookback, never later", () => {
    const rates = [
      { date: "2026-10-09", usdToCad: "1.3750" },
      { date: "2026-10-12", usdToCad: "1.3800" },
    ];
    expect(rateFor("2026-10-12", rates, 7)?.usdToCad).toBe("1.3800");
    expect(rateFor("2026-10-11", rates, 7)?.usdToCad).toBe("1.3750");
    expect(rateFor("2026-10-08", rates, 7)).toBeNull();
    expect(rateFor("2026-10-20", rates, 7)).toBeNull();
    expect(toCadCents(195000, "USD", rates[0]!)).toBe(268125);
    expect(toCadCents(195000, "CAD", null)).toBe(195000);
    expect(toCadCents(195000, "USD", null)).toBeNull();
  });
});

describe("tax code inference for unmapped lines (label AND rate must agree)", () => {
  const codes = baseContext().taxCodes;
  it.each([
    ["TVH (13 %)", null, "HST13"],
    ["HST (13%)", null, "HST13"],
    ["TPS (5 %)", null, "GST5"],
    ["GST/HST", 5, "GST5"],
    ["TVQ (9,975 %)", null, "QST9975"],
    ["PST (7%)", null, "PST7_BC"],
  ])("%s (rate %s) → %s", (label, rate, want) => expect(inferTaxCode(label, rate, codes)?.code).toBe(want));
  it.each([
    ["HST", null], // no rate
    ["TVH (15 %)", null], // no such code
    ["Eco fee (13%)", null], // no tax keyword
    ["QST (5%)", null], // keyword and rate disagree
  ])("%s stays unmapped", (label, rate) => expect(inferTaxCode(label, rate, codes)).toBeNull());
});
