/**
 * Run the dataset inbox (inbox/emails.json) through intake exactly as live Gmail mail, and save the
 * results to Postgres when DATABASE_URL is set (bills → validated, coded, audited; see intake-save.ts).
 *   npm run intake:dataset                       rules + Claude (one extraction call per bill-like document)
 *   npm run intake:dataset -- --no-save          classify and print only
 *   npm run intake:dataset -- --no-llm           rules only, free (bills land in manual entry)
 *   npm run intake:dataset -- --only EM-011,EM-029   just these emails
 *   npm run intake:dataset -- --limit 5          first N emails
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { InboxMessage } from "../src/contracts/intake";
import { createClaudeExtractor } from "../src/server/features/extraction/claude";
import { readDocument } from "../src/server/features/extraction/read-document";
import { taxCodesFromCsv } from "../src/server/features/extraction/tax-codes";
import { classifyEmail } from "../src/server/features/intake/classify/classify";
import { createClaudeClassifier } from "../src/server/features/intake/classify/claude";
import { fromDatasetFile } from "../src/server/features/intake/dataset/emails";
import { DATASET_DIR, vendorDomainsFromCsv } from "../src/server/features/intake/dataset/vendors";
import { DATASET_AS_OF } from "../src/server/features/validation/dataset/csv";
import { printResult } from "./intake-print";
import { createIntakeSaver } from "./intake-save";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const args = process.argv.slice(2);
const argValue = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const noLlm = args.includes("--no-llm");
const only = argValue("--only")?.split(",").map((s) => s.trim());
const limit = Number(argValue("--limit") ?? Infinity);

let emails = fromDatasetFile(JSON.parse(readFileSync(path.join(DATASET_DIR, "inbox/emails.json"), "utf8")))
  .map((e) => InboxMessage.parse(e));
if (only) emails = emails.filter((e) => only.includes(e.externalId));
emails = emails.slice(0, limit);

// The dataset's date rules run as of its own "today", not the machine's.
const saver = createIntakeSaver({ args, today: DATASET_AS_OF, storageKey: (_m, a) => `incoming_invoices/${path.basename(a.sourceRef)}` });
const extractor = noLlm ? undefined : createClaudeExtractor(taxCodesFromCsv());
const deps = {
  ctx: { knownVendorDomains: vendorDomainsFromCsv() },
  llm: noLlm ? undefined : createClaudeClassifier(),
  loadAttachment: saver.capture(async (_m, a) => readFileSync(path.join(DATASET_DIR, "incoming_invoices", path.basename(a.sourceRef)))),
  readDocument: (d: Parameters<typeof readDocument>[0]) => readDocument(d, { llm: extractor }),
};

const tally = new Map<string, number>();
let bills = 0;
for (const m of emails) {
  const r = await classifyEmail(m, deps);
  const c = r.classification;
  tally.set(`${c.decision}/${c.kind}`, (tally.get(`${c.decision}/${c.kind}`) ?? 0) + 1);
  bills += c.invoiceAttachments.length;
  printResult(m, r, { verbose: Boolean(only) || emails.length <= 5 });
  await saver.save(m, r);
}
console.log(`\n${emails.length} emails → ${bills} draft bills`);
for (const [k, n] of [...tally].sort()) console.log(`  ${String(n).padStart(3)}  ${k}`);
console.log(saver.summary());
await saver.close();
