/**
 * Pushes extraction output into the database through the real path (ingestInvoice): saved,
 * validated against Postgres, flags + audit trail written. Runs as the app role (DATABASE_URL).
 *   npm run db:ingest                       every fixture in fixtures/validation/incoming/
 *   npm run db:ingest -- path/to/a.json     one file: a ValidationInput, or a fixture { input }
 */
import { readFileSync } from "node:fs";
import { getDb } from "@/server/db/client";
import { loadIncomingFixtures } from "@/server/features/validation/dataset/batch";
import { ingestInvoice, IngestError } from "@/server/pipeline";

const file = process.argv[2];
const inputs = file ? [JSON.parse(readFileSync(file, "utf8"))].map((j) => j.input ?? j) : loadIncomingFixtures().map((f) => f.fixture.input);
const db = getDb();
let ok = 0;
for (const input of inputs) {
  try {
    const r = await ingestInvoice(input, { source: "email", db });
    ok++;
    console.log(`✓ ${r.invoiceId}  flags: ${r.result.flags.map((f) => f.code).join(", ") || "none"}`);
  } catch (err) {
    console.log(`✗ ${input.invoiceId}: ${err instanceof IngestError ? err.message : String(err)}`);
  }
}
console.log(`${ok}/${inputs.length} ingested`);
process.exit(0);
