import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodingResult } from "@/contracts/coding";
import { ValidationInput } from "@/contracts/validation";
import { suggestCoding } from "..";
import { loadCodingContext } from "./dataset";

/**
 * fixtures/coding/*.json are frozen outputs of this stage (docs/rules/contracts.md) for approvals,
 * the review screen and the audit view to build against. Each holds an `input` (an incoming
 * invoice as extracted) and the `vendorId` validation resolved; `result` is suggestCoding's output.
 * The test fails if a fixture no longer matches a fresh run. Regenerate after an intended change:
 *   UPDATE_FIXTURES=1 npx vitest run src/server/features/coding/__tests__/fixtures.test.ts
 */
const DIR = path.resolve(process.cwd(), "fixtures/coding");
const UPDATE = process.env.UPDATE_FIXTURES === "1";
const files = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
const ctx = loadCodingContext();

interface Fixture {
  description: string;
  source: string;
  vendorId: string | null;
  input: unknown;
  result: unknown;
}

describe("coding fixtures", () => {
  it("exist", () => expect(files.length).toBeGreaterThan(0));

  it.each(files)("%s is valid and matches a fresh run", (file) => {
    const fx = JSON.parse(readFileSync(path.join(DIR, file), "utf8")) as Fixture;
    const result = suggestCoding(ValidationInput.parse(fx.input), fx.vendorId, ctx);
    if (UPDATE) {
      writeFileSync(path.join(DIR, file), `${JSON.stringify({ ...fx, result }, null, 2)}\n`);
      return;
    }
    expect(CodingResult.safeParse(fx.result).success, "result does not match the contract").toBe(true);
    expect(fx.result, "stale: regenerate with UPDATE_FIXTURES=1").toEqual(result);
  });
});
