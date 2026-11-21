import { describe, expect, it } from "vitest";
import type { CodingConfidence } from "@/contracts/coding";
import { CodingIndex, suggestCoding } from "..";
import { historicalInvoices, loadCodingContext } from "./dataset";

/**
 * The honest accuracy number. Replay the 426 historical invoices in date order and code each one
 * using ONLY the invoices before it — exactly what the system would have known that day — then
 * compare with how a person actually coded it. Early invoices have no history, so this
 * understates accuracy at today's history size.
 */

interface Score {
  lines: number;
  right: number;
  byConfidence: Record<CodingConfidence, { lines: number; right: number }>;
}

const empty = (): Score => ({
  lines: 0,
  right: 0,
  byConfidence: { high: { lines: 0, right: 0 }, medium: { lines: 0, right: 0 }, low: { lines: 0, right: 0 }, none: { lines: 0, right: 0 } },
});

function replay(withRequester: boolean): { account: Score; department: Score } {
  const ctx = { ...loadCodingContext([]), history: new CodingIndex() };
  const account = empty();
  const department = empty();
  for (const inv of historicalInvoices()) {
    const input = withRequester ? { ...inv.input, requesterId: inv.requesterId } : inv.input;
    const result = suggestCoding(input, inv.vendorId, ctx);
    for (const l of result.lines) {
      const actual = inv.actual.find((a) => a.lineNo === l.lineNo)!;
      for (const [score, s, truth] of [
        [account, l.account, actual.glAccount],
        [department, l.department, actual.departmentId],
      ] as const) {
        const ok = s.value === truth;
        score.lines++;
        score.byConfidence[s.confidence].lines++;
        if (ok) {
          score.right++;
          score.byConfidence[s.confidence].right++;
        }
      }
    }
    for (const a of inv.actual) ctx.history.add(a); // the invoice becomes history for the next ones
  }
  return { account, department };
}

const pct = (right: number, lines: number) => (lines === 0 ? "—" : `${((100 * right) / lines).toFixed(1)}%`);
const summary = (s: Score) =>
  `${pct(s.right, s.lines)} of ${s.lines} lines · ` +
  (["high", "medium", "low", "none"] as const).map((c) => `${c} ${s.byConfidence[c].right}/${s.byConfidence[c].lines}`).join(" · ");

describe("chronological backtest on the 426 historical invoices", () => {
  const blind = replay(false);
  const known = replay(true);

  it("suggests the right account for almost every line, and is never wrong when it says high", () => {
    console.log(`account:                      ${summary(blind.account)}`);
    expect(blind.account.right / blind.account.lines).toBeGreaterThanOrEqual(0.99);
    expect(blind.account.byConfidence.high.right).toBe(blind.account.byConfidence.high.lines);
    expect(blind.account.byConfidence.none.lines).toBeLessThanOrEqual(5);
  });

  it("department: always right when the requester is known", () => {
    console.log(`department (requester known): ${summary(known.department)}`);
    expect(known.department.right).toBe(known.department.lines);
  });

  it("department without a requester: right when it says high, and honest (low / none) when it cannot know", () => {
    console.log(`department (no requester):    ${summary(blind.department)}`);
    const high = blind.department.byConfidence.high;
    expect(high.right / high.lines).toBeGreaterThanOrEqual(0.99);
    expect(blind.department.right / blind.department.lines).toBeGreaterThanOrEqual(0.75);
  });
});
