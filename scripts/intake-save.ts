/**
 * Saving intake results to Postgres, shared by gmail-poll and intake-dataset: each classified email
 * goes through ingestFromIntake (src/server/pipeline/intake.ts) — readable bills are saved, validated,
 * coded and audited; unreadable bills land in ManualEntry; everything else stays on the email.
 *
 * On when DATABASE_URL is set (.env, see .env.example); `--no-save` keeps the old print-only run.
 */
import type { InboxMessage } from "../src/contracts/intake";
import type { IntakeResult } from "../src/server/features/intake/classify/classify";
import { getDb } from "../src/server/db/client";
import { ingestFromIntake, type IntakeAttachmentFile, type IntakeOutcome } from "../src/server/pipeline";

type LoadAttachment = (m: InboxMessage, a: { sourceRef: string; filename: string }) => Promise<Buffer>;

/** Where an attachment's bytes go; may write them first (Gmail → the uploads folder) and return the key. */
type StorageKey = (m: InboxMessage, a: { sourceRef: string; filename: string }, bytes: Buffer) => string | Promise<string>;

export function createIntakeSaver(opts: { args: string[]; today?: string; storageKey: StorageKey }) {
  const enabled = !opts.args.includes("--no-save") && Boolean(process.env.DATABASE_URL);
  if (opts.args.includes("--no-save")) console.log("Not saving (--no-save): results are printed only.");
  else if (!enabled) console.log("Not saving: DATABASE_URL is not set (copy .env.example to .env and run `npm run db:up && npm run db:reset`).");

  // The bytes intake already loaded, kept per email so the bill's documents row gets its sha256.
  const files = new Map<string, Record<string, IntakeAttachmentFile>>();
  const tally = new Map<IntakeOutcome["outcome"], number>();

  return {
    enabled,
    /** Wraps intake's loadAttachment so the bytes are not fetched twice. */
    capture(load: LoadAttachment): LoadAttachment {
      return async (m, a) => {
        const bytes = await load(m, a);
        if (enabled) files.set(m.externalId, { ...files.get(m.externalId), [a.sourceRef]: { bytes, storageKey: await opts.storageKey(m, a, bytes) } });
        return bytes;
      };
    },
    /** Saves one classified email. Throws if the database write fails (the caller decides what that means). */
    async save(m: InboxMessage, r: IntakeResult): Promise<IntakeOutcome[]> {
      if (!enabled) return [];
      try {
        const outcomes = await ingestFromIntake(m, r, { db: getDb(), today: opts.today, attachments: files.get(m.externalId) });
        for (const o of outcomes) {
          tally.set(o.outcome, (tally.get(o.outcome) ?? 0) + 1);
          const detail =
            o.outcome === "ingested" ? `${o.invoiceId} → ${o.analysis.status}, flags: ${[...new Set(o.analysis.result.flags.map((f) => f.code))].join(", ") || "none"}`
            : o.outcome === "manual_entry" ? `${o.invoiceId} → ManualEntry (${o.reason})`
            : o.outcome === "already_ingested" ? `${o.invoiceId} (already saved)`
            : o.reason;
          console.log(`    saved · ${o.sourceRef}: ${o.outcome} — ${detail}`);
        }
        return outcomes;
      } finally {
        files.delete(m.externalId);
      }
    },
    summary(): string {
      if (!enabled) return "Nothing saved.";
      return `Saved to Postgres: ${[...tally].map(([k, n]) => `${n} ${k}`).join(", ") || "no attachments"}`;
    },
    async close() {
      if (!enabled) return;
      // Server Postgres (postgres.js) closes with end(); the embedded demo database (PGlite) with close().
      const client = (getDb() as unknown as { $client: { end?: () => Promise<void>; close?: () => Promise<void> } }).$client;
      await (client.end ?? client.close)?.call(client);
    },
  };
}
