/** Freeze real stage outputs. First capture: --live (three Claude document reads).
 * Default: replay the saved raw replies through the current code, with no API calls.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DocumentReading } from "../src/contracts/extraction";
import { InboxMessage, IntakeClassification } from "../src/contracts/intake";
import { createClaudeExtractor } from "../src/server/features/extraction/claude";
import { llmExtractionSchema } from "../src/server/features/extraction/prompt";
import { readDocument } from "../src/server/features/extraction/read-document";
import { taxCodesFromCsv } from "../src/server/features/extraction/tax-codes";
import { classifyEmail } from "../src/server/features/intake/classify/classify";
import { fromDatasetFile } from "../src/server/features/intake/dataset/emails";
import { DATASET_DIR, vendorDomainsFromCsv } from "../src/server/features/intake/dataset/vendors";

const live = process.argv.includes("--live");
const onlyIndex = process.argv.indexOf("--only");
const only = onlyIndex < 0 ? null : process.argv[onlyIndex + 1];
if (live && existsSync(".env.local")) process.loadEnvFile(".env.local");
const taxCodes = taxCodesFromCsv();
const extractor = live ? createClaudeExtractor(taxCodes) : undefined;
const messages = fromDatasetFile(JSON.parse(readFileSync(path.join(DATASET_DIR, "inbox/emails.json"), "utf8")))
  .map((m) => InboxMessage.parse(m));
const cases = [
  { id: "EM-014", key: "vendor-invoice", manual: false },
  { id: "EM-011", key: "scanned-invoice", manual: false },
  { id: "EM-042", key: "credit-note", manual: false },
  { id: "EM-001", key: "manual-invoice", manual: true },
  { id: "EM-011", key: "uncertain-scan", manual: true },
  { id: "EM-056", key: "statement", manual: false },
  { id: "EM-058", key: "missing-attachment", manual: false },
  { id: "EM-059", key: "marketing", manual: false },
];

function save(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

for (const c of cases.filter((c) => !only || c.key === only)) {
  const message = messages.find((m) => m.externalId === c.id);
  if (!message) throw new Error(`Dataset email ${c.id} missing`);
  const readingFile = path.join("fixtures/extraction", `${c.key}.json`);
  const previous = !live && !c.manual && message.attachments.length
    ? DocumentReading.parse(JSON.parse(readFileSync(readingFile, "utf8"))) : null;
  const reply = previous?.llmRaw == null ? null : llmExtractionSchema(taxCodes).parse(previous.llmRaw);
  const llm = c.manual ? undefined : extractor ?? (reply ? async () => reply : undefined);
  const result = await classifyEmail(message, {
    ctx: { knownVendorDomains: vendorDomainsFromCsv() },
    loadAttachment: async (_m, a) => readFileSync(path.join(DATASET_DIR, "incoming_invoices", path.basename(a.sourceRef))),
    readDocument: async (doc) => {
      const reading = await readDocument(doc, { llm });
      if (!c.manual && (!reading.extracted || reading.decidedBy !== "llm")) {
        throw new Error(`${c.key}: expected a real extraction; ${reading.error ?? reading.reason}`);
      }
      save(readingFile, DocumentReading.parse(reading));
      return reading;
    },
  });
  save(path.join("fixtures/intake/messages", `${c.key}.json`), InboxMessage.parse(message));
  save(path.join("fixtures/intake", `${c.key}.json`), IntakeClassification.parse(result.classification));
  console.log(`${c.key}: ${result.classification.decision}, ${result.readings.length} document(s)`);
}
