/**
 * Regenerates fixtures/audit/ from a REAL run (docs/rules/contracts.md: fixtures come from real
 * runs): in-process Postgres → migrate → seed → ingest the incoming batch → one override → read the
 * auditor screens. The dashboard owner builds against these files without needing a database.
 *   npm run audit:fixtures
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createSeededDb } from "@/server/db/__tests__/helpers";
import { getInvoiceAuditDetail, listAuditInvoices } from "@/server/features/audit";
import { loadIncomingFixtures } from "@/server/features/validation/dataset/batch";
import { ingestInvoice } from "@/server/pipeline";
import { overrideFlag } from "@/server/features/validation/db/override";

const TODAY = "2026-11-02";
const out = path.resolve("fixtures/audit");
mkdirSync(out, { recursive: true });

const { db, client } = await createSeededDb({ validateHistory: true });
const q = async <T>(s: string) => (await client.query<T>(s)).rows;
const [auditor] = await q<{ id: string }>("SELECT id FROM users WHERE role = 'auditor' ORDER BY id LIMIT 1");
const [clerk] = await q<{ id: string }>("SELECT id FROM users WHERE role = 'ap_clerk' ORDER BY id LIMIT 1");
await client.exec("SET ROLE ap_app");
for (const { fixture } of loadIncomingFixtures()) await ingestInvoice(fixture.input, { source: "email", today: TODAY, db });

// A new invoice with a flag a clerk overrode — the case auditors look for first.
const [flag] = await q<{ id: number; invoice_id: string }>("SELECT id, invoice_id FROM invoice_flags WHERE source = 'validation' AND status = 'open' AND severity = 'warn' AND invoice_id NOT LIKE 'AP-%' ORDER BY id LIMIT 1");
await overrideFlag({ userId: clerk!.id, role: "ap_clerk" }, flag!.id, "Confirmed with the vendor by phone; acceptable for this billing period.", { db });

// A paid historical invoice that validation now flags as blocking (a duplicate that was paid).
const [paidDup] = await q<{ invoice_id: string }>(
  "SELECT f.invoice_id FROM invoice_flags f JOIN invoices i ON i.id = f.invoice_id WHERE i.status = 'Paid' AND f.severity = 'block' ORDER BY f.invoice_id LIMIT 1",
);

const actor = { userId: auditor!.id, role: "auditor" as const };
const write = (name: string, data: unknown) => writeFileSync(path.join(out, name), JSON.stringify(data, null, 2) + "\n");
write("invoice-list.json", await listAuditInvoices(actor, { pageSize: 25 }, { db }));
write("invoice-list-overrides.json", await listAuditInvoices(actor, { hasOverrides: true }, { db }));
write("invoice-detail-new-with-override.json", await getInvoiceAuditDetail(actor, flag!.invoice_id, { db }));
write("invoice-detail-historical-paid.json", await getInvoiceAuditDetail(actor, paidDup?.invoice_id ?? "AP-00001", { db }));
console.log(`wrote fixtures/audit/ (override on ${flag!.invoice_id}, historical ${paidDup?.invoice_id ?? "AP-00001"})`);
process.exit(0);
