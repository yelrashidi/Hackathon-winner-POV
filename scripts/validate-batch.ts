/**
 * Runs validation over the incoming batch fixtures and prints every flag.
 *   npm run validate:batch            all invoices
 *   npm run validate:batch -- 4443    only fixtures whose file name contains "4443"
 */
import { loadDatasetContext } from "@/server/features/validation/dataset/load-context";
import { loadIncomingFixtures, validateBatch } from "@/server/features/validation/dataset/batch";

const filter = process.argv[2]?.toLowerCase();
const all = loadIncomingFixtures();
const results = validateBatch(all.map((f) => f.fixture.input), loadDatasetContext());

let mismatches = 0;
const counts = new Map<string, number>();
all.forEach(({ file, fixture }, i) => {
  const r = results[i]!;
  const codes = [...new Set(r.flags.map((f) => f.code))].sort();
  for (const c of codes) counts.set(c, (counts.get(c) ?? 0) + 1);
  const expected = fixture.expectedCodes ? [...fixture.expectedCodes].sort() : null;
  const ok = expected !== null && JSON.stringify(expected) === JSON.stringify(codes);
  if (!ok) mismatches++;
  if (filter && !file.toLowerCase().includes(filter)) return;
  console.log(`\n${ok ? "✓" : "✗"} ${file}  vendor=${r.vendorId ?? "?"}  province=${r.deliveryProvince ?? "?"}  CAD=${r.totalCadCents}`);
  if (!ok) console.log(`   expected: ${expected?.join(", ") || "(none)"}\n   got:      ${codes.join(", ") || "(none)"}`);
  for (const f of r.flags) console.log(`   [${f.severity}] ${f.code}: ${f.message}`);
});
console.log(`\n${all.length} invoices · ${all.length - mismatches} match expectations · ${mismatches} differ`);
console.log([...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}=${n}`).join("  "));
// A mismatch must fail CI as well as appear in the diagnostic output.
if (mismatches > 0) process.exitCode = 1;
