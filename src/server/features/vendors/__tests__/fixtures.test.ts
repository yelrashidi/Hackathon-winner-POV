import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VendorDetail, VendorDraft, VendorList } from "@/contracts/vendor";

/**
 * fixtures/vendors/ is what the dashboard owner builds the vendor screens from. If the contract
 * changes, this fails until `npx tsx scripts/vendor-fixtures.ts` regenerates them.
 */
const read = (f: string) => JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../../../../fixtures/vendors", f), "utf8"));

describe("vendor fixtures match the contract", () => {
  it.each([
    ["vendor-list.json", VendorList],
    ["vendor-detail.json", VendorDetail],
    ["vendor-detail-as-onboarder.json", VendorDetail],
    ["vendor-draft.json", VendorDraft],
  ] as const)("%s", (file, schema) => {
    const parsed = schema.safeParse(read(file));
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);
  });

  it("never contain a full bank account number (last 4 digits only)", () => {
    for (const f of ["vendor-detail.json", "vendor-detail-as-onboarder.json"]) {
      const detail = read(f) as { bankAccounts: Record<string, unknown>[] };
      for (const b of detail.bankAccounts) expect(Object.keys(b)).not.toContain("account");
    }
  });
});
