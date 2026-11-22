import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Db } from "@/server/db/client";
import * as schema from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed/seed";
import { resetDemoDb, usingDemoDb } from "./database";
import { loadDatasetInbox } from "./load-inbox";

/**
 * "Reset demo data" (Demo controls, Admin only): back to where the demo starts, everything done in
 * the app thrown away — uploads, Gmail bills, checks, approvals, releases, bank answers, journal exports.
 *
 *   in-memory demo (no DATABASE_URL)       → rebuild the in-process database (resetDemoDb)
 *   Docker Postgres (DEMO_RESET_DATABASE_URL set, local host only)
 *                                          → in ONE transaction, as the database owner: empty every
 *                                            table, then buildDemoBaseline()
 *   anything else (Supabase, a teammate's DB) → not available
 *
 * The app itself runs as `ap_app`, which can never delete audit rows, and the audit log's trigger
 * refuses TRUNCATE even for the owner. The reset is the one place that switches that trigger off,
 * for the length of its own transaction, and only with the owner's login that docker-compose gives
 * the app container. If anything fails, the transaction rolls back and the old data stays.
 * Tables are emptied, not dropped, so the app's and the Gmail poller's open connections keep working.
 */

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "db"];

export type ResetMode = "memory" | "postgres" | null;

/**
 * The demo's starting point, the same as the in-memory demo builds (src/server/demo/database.ts):
 * the dataset's history and its audit trail (as the owner: it writes historical timestamps), then
 * the dataset's AP inbox through intake as the restricted `ap_app` role — the clerk's Checks queue.
 * Call inside a transaction on an owner connection (SET LOCAL ROLE ends with it).
 */
export async function buildDemoBaseline(owner: Db): Promise<Record<string, number>> {
  const counts = await seedDatabase(owner, { validateHistory: true });
  await owner.execute(sql`SET LOCAL ROLE ap_app`);
  const inbox = await loadDatasetInbox(owner);
  return { ...counts, inboxBillsIngested: inbox.ingested, inboxManualEntry: inbox.manual_entry };
}

export function demoResetMode(): ResetMode {
  if (usingDemoDb()) return "memory";
  const url = process.env.DEMO_RESET_DATABASE_URL;
  if (!url) return null;
  try {
    return LOCAL_HOSTS.includes(new URL(url).hostname) ? "postgres" : null;
  } catch {
    return null;
  }
}

export async function resetDemoData(): Promise<Record<string, number> | null> {
  const mode = demoResetMode();
  if (mode === "memory") {
    await resetDemoDb();
    return null;
  }
  if (mode !== "postgres") throw new Error("Reset is only available on the demo or the local Docker database.");

  const client = postgres(process.env.DEMO_RESET_DATABASE_URL!, { max: 1, onnotice: () => {} });
  try {
    const owner = drizzle(client, { schema });
    return await owner.transaction(async (tx) => {
      const tables = await tx.execute<{ name: string }>(sql`SELECT quote_ident(tablename) AS name FROM pg_tables WHERE schemaname = 'public'`);
      const list = tables.map((t) => `public.${t.name}`).join(", ");
      await tx.execute(sql`ALTER TABLE audit_events DISABLE TRIGGER USER`);
      await tx.execute(sql.raw(`TRUNCATE ${list} RESTART IDENTITY CASCADE`));
      await tx.execute(sql`ALTER TABLE audit_events ENABLE TRIGGER USER`);
      return buildDemoBaseline(tx as unknown as Db);
    });
  } finally {
    await client.end();
  }
}
