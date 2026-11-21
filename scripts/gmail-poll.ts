/**
 * Step-1 check of the Gmail connector: poll once (or keep polling) and print what intake sees.
 * Nothing is classified or stored yet; the cursor lives in .intake/gmail-state.json (gitignored)
 * until the intake tables exist.
 *
 *   npm run gmail:poll                       first run records "now"; later runs print new mail
 *   npm run gmail:poll -- --backfill 1d      one-off: also show inbox mail from the last day
 *   npm run gmail:poll -- --watch 30         poll every 30 s
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createClaudeExtractor } from "../src/server/features/extraction/claude";
import { readDocument } from "../src/server/features/extraction/read-document";
import { taxCodesFromCsv } from "../src/server/features/extraction/tax-codes";
import { classifyEmail } from "../src/server/features/intake/classify/classify";
import { createClaudeClassifier } from "../src/server/features/intake/classify/claude";
import { vendorDomainsFromCsv } from "../src/server/features/intake/dataset/vendors";
import { createGmailClient } from "../src/server/features/intake/gmail/client";
import { fetchGmailAttachment, pollGmail } from "../src/server/features/intake/gmail/poll";
import { printResult } from "./intake-print";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const STATE_DIR = ".intake";
const STATE_FILE = `${STATE_DIR}/gmail-state.json`;
const args = process.argv.slice(2);
const argValue = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const backfill = argValue("--backfill");
const watchSeconds = Number(argValue("--watch") ?? 0);

const loadCursor = (): string | null =>
  existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, "utf8")).cursor ?? null) : null;
const saveCursor = (cursor: string) => {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ cursor, savedAt: new Date().toISOString() }, null, 2));
};

const client = createGmailClient();
const noLlm = args.includes("--no-llm");
const extractor = noLlm ? undefined : createClaudeExtractor(taxCodesFromCsv());
const deps = {
  ctx: { knownVendorDomains: vendorDomainsFromCsv() },
  llm: noLlm ? undefined : createClaudeClassifier(),
  loadAttachment: (m: { externalId: string }, a: { sourceRef: string }) => fetchGmailAttachment(client, m.externalId, a.sourceRef),
  readDocument: (d: Parameters<typeof readDocument>[0]) => readDocument(d, { llm: extractor }),
};

async function pollOnce(backfillQuery?: string) {
  const result = await pollGmail(client, { cursor: loadCursor(), backfillQuery: backfillQuery && `newer_than:${backfillQuery}` });
  saveCursor(result.cursor);
  const stamp = new Date().toLocaleTimeString();
  if (result.note === "baseline") console.log(`[${stamp}] Connected. Baseline recorded — new mail from now on will appear here.`);
  if (result.note === "cursor_expired_reset") console.log(`[${stamp}] Cursor expired (>~7 days); reset to now.`);
  for (const m of result.messages) {
    const att = m.attachments.map((a) => `${a.filename} (${a.mimeType})`).join(", ") || "— no attachment —";
    console.log(`\n[${stamp}] ${m.receivedAt}  ${m.fromName ?? ""} <${m.fromAddress}>\n  Subject: ${m.subject}\n  Attachments: ${att}\n  Body: ${m.bodyText.slice(0, 160).replace(/\s+/g, " ")}`);
    printResult(m, await classifyEmail(m, deps), { verbose: true });
  }
  for (const r of result.rejected) console.warn(`[${stamp}] Rejected ${r.id}: ${r.reason}`);
  if (result.note !== "baseline" && result.messages.length === 0) console.log(`[${stamp}] No new mail.`);
}

await pollOnce(backfill);
if (watchSeconds > 0) {
  console.log(`Watching every ${watchSeconds}s — Ctrl+C to stop.`);
  setInterval(() => pollOnce().catch((e) => console.error(String(e))), watchSeconds * 1000);
}
