/**
 * Runs the duplicate check over the incoming batch (against history + the rest of the batch) and
 * replays it over the history itself. Prints every flag.
 *   npm run duplicates:batch
 *   npm run duplicates:batch -- history     the history replay only
 */
import { checkDuplicates, type DuplicateResult } from "@/server/features/duplicates";
import { incomingToRecord, loadDatasetDuplicateContext } from "@/server/features/duplicates/dataset";
import { loadIncomingFixtures } from "@/server/features/validation/dataset/batch";
import { loadDatasetContext } from "@/server/features/validation/dataset/load-context";

const mode = process.argv[2]?.toLowerCase();
const base = loadDatasetDuplicateContext();
const print = (label: string, r: DuplicateResult) => {
  if (!r.flags.length) return;
  console.log(`\n${label}`);
  for (const f of r.flags) console.log(`   [${f.severity}] ${f.code}: ${f.message}`);
};
const tally = (results: DuplicateResult[]) => {
  const counts = new Map<string, number>();
  for (const r of results) for (const f of r.flags) counts.set(f.code, (counts.get(f.code) ?? 0) + 1);
  return [...counts.entries()].map(([c, n]) => `${c}=${n}`).join("  ") || "no flags";
};

if (mode !== "history") {
  const vctx = loadDatasetContext();
  const fixtures = loadIncomingFixtures();
  const batch = fixtures.map(({ fixture }) => incomingToRecord(fixture.input, vctx));
  const ctx = { ...base, invoices: [...base.invoices, ...batch] };
  const results = batch.map((inv) => checkDuplicates(inv, ctx));
  results.forEach((r, i) => print(`${fixtures[i]!.file}  vendor=${batch[i]!.vendorId ?? "?"}`, r));
  console.log(`\nINCOMING: ${fixtures.length} invoices · ${results.filter((r) => r.flags.length).length} flagged · ${tally(results)}`);
}

if (mode !== "batch") {
  const results = base.invoices.map((inv) => checkDuplicates(inv, base));
  results.forEach((r) => print(`${r.invoiceId}`, r));
  console.log(`\nHISTORY: ${base.invoices.length} invoices · ${results.filter((r) => r.flags.length).length} flagged · ${tally(results)}`);
}
