import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AuditInvoiceDetail, AuditInvoiceList } from "@/contracts/audit-view";

// Every frozen auditor-screen fixture still matches the contract the dashboard is built against.
const dir = path.resolve(import.meta.dirname, "../../../../../fixtures/audit");
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

describe("fixtures/audit", () => {
  it("exist", () => expect(files.length).toBeGreaterThanOrEqual(4));
  it.each(files)("%s matches its contract", (file) => {
    const data = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
    const schema = file.startsWith("invoice-list") ? AuditInvoiceList : AuditInvoiceDetail;
    expect(schema.safeParse(data).success).toBe(true);
  });
});
