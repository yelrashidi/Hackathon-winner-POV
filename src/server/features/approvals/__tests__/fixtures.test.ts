import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalInput, ApprovalPlan } from "@/contracts/approvals";
import { planApprovals } from "..";
import { approveAll, loadContext } from "./dataset";

/**
 * fixtures/approvals/*.json are frozen outputs of this stage (docs/rules/contracts.md), for
 * payments (feature 7) and the UI to build against. Each holds an `input`; `plan` is what
 * planApprovals returns for it and `approved` is that plan after every step is approved.
 *
 * This test fails if a fixture no longer matches a fresh run, so a fixture cannot quietly become
 * a lie. After an intentional change, regenerate:  UPDATE_FIXTURES=1 npx vitest run fixtures
 */
const DIR = path.resolve(process.cwd(), "fixtures/approvals");
const UPDATE = process.env.UPDATE_FIXTURES === "1";
const files = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();

interface Fixture {
  description: string;
  asOf: string;
  decidedAt: string;
  input: unknown;
  plan: unknown;
  approved: unknown;
}

describe("approval fixtures", () => {
  it("exist", () => expect(files.length).toBeGreaterThan(0));

  it.each(files)("%s is valid and matches a fresh run", (file) => {
    const fx = JSON.parse(readFileSync(path.join(DIR, file), "utf8")) as Fixture;
    const input = ApprovalInput.parse(fx.input);
    const ctx = loadContext(new Date(fx.asOf));
    const plan = planApprovals(input, ctx);
    const approved = plan.outcome === "route" ? approveAll(plan, input, ctx, new Date(fx.decidedAt)) : null;

    if (UPDATE) {
      writeFileSync(path.join(DIR, file), `${JSON.stringify({ ...fx, plan, approved }, null, 2)}\n`);
      return;
    }
    expect(ApprovalPlan.safeParse(fx.plan).success, "plan does not match the contract").toBe(true);
    if (fx.approved !== null) expect(ApprovalPlan.safeParse(fx.approved).success, "approved does not match the contract").toBe(true);
    expect(fx.plan, "stale: regenerate with UPDATE_FIXTURES=1").toEqual(plan);
    expect(fx.approved, "stale: regenerate with UPDATE_FIXTURES=1").toEqual(approved);
  });
});
