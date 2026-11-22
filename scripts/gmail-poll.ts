/**
 * The Gmail connector: poll once (or keep polling), classify and read each new email, print it, and
 * save it to Postgres when DATABASE_URL is set (bills → validated, coded, audited; see intake-save.ts).
 * The cursor lives in .intake/gmail-state.json (gitignored) and advances only after every new email
 * is saved, so a database error means the next poll retries them (saving is idempotent).
 *
 *   npm run gmail:poll                       first run records "now"; later runs print new mail
 *   npm run gmail:poll -- --no-save          classify and print only
 *   npm run gmail:poll -- --backfill 1d      one-off: also show inbox mail from the last day
 *   npm run gmail:poll -- --watch 30         poll every 30 s
 *
 * GMAIL_BACKFILL=1d (env): on the very FIRST run only (no cursor yet), read the inbox back that far
 * instead of starting from "now" — so bills that arrived before the poller started (e.g. a fresh
 * `docker compose up`) still reach the dashboard. Saving is idempotent, so overlap is harmless.
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
import { writeUploadFile } from "../src/server/pipeline/documents";
import { printResult } from "./intake-print";
import { createIntakeSaver } from "./intake-save";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const STATE_DIR = ".intake";
const STATE_FILE = `${STATE_DIR}/gmail-state.json`;
const args = process.argv.slice(2);
const argValue = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const firstRunBackfill = loadCursor() === null ? process.env.GMAIL_BACKFILL || undefined : undefined;
const backfill = argValue("--backfill") ?? firstRunBackfill;
if (firstRunBackfill && !argValue("--backfill")) console.log(`First run: backfilling inbox mail newer than ${firstRunBackfill} (GMAIL_BACKFILL).`);
const watchSeconds = Number(argValue("--watch") ?? 0);

function loadCursor(): string | null {
  return existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, "utf8")).cursor ?? null) : null;
}
const saveCursor = (cursor: string) => {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ cursor, savedAt: new Date().toISOString() }, null, 2));
};

const client = createGmailClient();
// Gmail attachments are kept in the uploads folder (shared with the app in Docker), so the review
// screen and the audit trail can open the exact PDF the bill was read from.
const saver = createIntakeSaver({
  args,
  storageKey: async (m, a, bytes) =>
    (await writeUploadFile({ bytes, fileName: a.filename, mime: m.attachments.find((x) => x.sourceRef === a.sourceRef)?.mimeType })).storageKey,
});
const noLlm = args.includes("--no-llm");
const extractor = noLlm ? undefined : createClaudeExtractor(taxCodesFromCsv());
const deps = {
  ctx: { knownVendorDomains: vendorDomainsFromCsv() },
  llm: noLlm ? undefined : createClaudeClassifier(),
  loadAttachment: saver.capture((m, a) => fetchGmailAttachment(client, m.externalId, a.sourceRef)),
  readDocument: (d: Parameters<typeof readDocument>[0]) => readDocument(d, { llm: extractor }),
};

async function pollOnce(backfillQuery?: string) {
  const result = await pollGmail(client, { cursor: loadCursor(), backfillQuery: backfillQuery && `newer_than:${backfillQuery}` });
  const stamp = new Date().toLocaleTimeString();
  if (result.note === "baseline") console.log(`[${stamp}] Connected. Baseline recorded — new mail from now on will appear here.`);
  if (result.note === "cursor_expired_reset") console.log(`[${stamp}] Cursor expired (>~7 days); reset to now.`);
  const unsaved: string[] = [];
  for (const m of result.messages) {
    const att = m.attachments.map((a) => `${a.filename} (${a.mimeType})`).join(", ") || "— no attachment —";
    console.log(`\n[${stamp}] ${m.receivedAt}  ${m.fromName ?? ""} <${m.fromAddress}>\n  Subject: ${m.subject}\n  Attachments: ${att}\n  Body: ${m.bodyText.slice(0, 160).replace(/\s+/g, " ")}`);
    const r = await classifyEmail(m, deps);
    printResult(m, r, { verbose: true });
    try {
      await saver.save(m, r);
    } catch (err) {
      unsaved.push(m.externalId);
      console.error(`[${stamp}] Could not save ${m.externalId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Advance only when every new email is in the database; otherwise the next poll sees them again.
  if (unsaved.length === 0) saveCursor(result.cursor);
  else console.warn(`[${stamp}] Cursor not advanced: ${unsaved.length} email(s) not saved (${unsaved.join(", ")}); they will be retried.`);
  for (const r of result.rejected) console.warn(`[${stamp}] Rejected ${r.id}: ${r.reason}`);
  if (result.note !== "baseline" && result.messages.length === 0) console.log(`[${stamp}] No new mail.`);
}

await pollOnce(backfill);
if (watchSeconds <= 0) await saver.close();
else {
  console.log(`Watching every ${watchSeconds}s — Ctrl+C to stop.`);
  // Sequential, not setInterval: a poll that runs longer than the interval (LLM extraction) must
  // finish and save its cursor before the next one starts, or two polls race on the same mail.
  for (;;) {
    await new Promise((r) => setTimeout(r, watchSeconds * 1000));
    await pollOnce().catch((e) => console.error(String(e)));
  }
}
