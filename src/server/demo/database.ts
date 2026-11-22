import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { getDb, restrictToAppRole, setDb, type Db } from "@/server/db/client";
import * as schema from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed/seed";
import { loadDatasetInbox } from "./load-inbox";

/**
 * The database the app runs on.
 *
 *   DATABASE_URL set   → Postgres (Docker locally, Supabase deployed): getDb() as usual.
 *   DATABASE_URL unset → the DEMO database: an in-process Postgres (PGlite, the same engine the
 *                        tests use), built on first use from the dataset in ~5 seconds:
 *                        migrations → seed (10 months of history + its audit trail) → the AP inbox
 *                        through intake (src/server/demo/load-inbox.ts). Lives in memory: a server
 *                        restart or "Reset demo data" starts again from the dataset.
 *
 * Every page and server action awaits ensureDb() before calling a service, so the services keep
 * calling getDb() exactly as they do against a real Postgres.
 */

const KEY = Symbol.for("harborline.demo-db");
type Holder = { [KEY]?: { ready: Promise<Db>; client: PGlite | null } };
const holder = globalThis as Holder;

export const MIGRATIONS_DIR = path.join(process.cwd(), "src/server/db/migrations");

export function usingDemoDb(): boolean {
  return !process.env.DATABASE_URL;
}

async function buildDemoDb(client: PGlite): Promise<Db> {
  const started = Date.now();
  const owner = drizzle(client, { schema }) as unknown as Db;
  await migrate(owner as unknown as Parameters<typeof migrate>[0], { migrationsFolder: MIGRATIONS_DIR });
  await seedDatabase(owner, { validateHistory: true }); // as owner: it writes historical occurred_at
  // From here on the app runs as the restricted `ap_app` role, like the real database (audit guards apply).
  const db = drizzle(restrictToAppRole(client), { schema }) as unknown as Db;
  await loadDatasetInbox(db);
  // DEMO_SCENARIO=N: start with N clean bills already sent to approval (same as the Demo controls button).
  const scenario = Number(process.env.DEMO_SCENARIO ?? 0);
  if (scenario > 0) {
    const { sendCleanBillsToApproval } = await import("./scenario");
    await sendCleanBillsToApproval(scenario, { db });
  }
  console.log(`[demo-db] in-process Postgres ready in ${((Date.now() - started) / 1000).toFixed(1)}s (no DATABASE_URL set)`);
  return db;
}

/** The app's database, ready to query. Builds the demo database on first call when there is no DATABASE_URL. */
export async function ensureDb(): Promise<Db> {
  if (!usingDemoDb()) return getDb();
  if (!holder[KEY]) {
    const client = new PGlite();
    const ready = buildDemoDb(client);
    holder[KEY] = { ready, client };
    // A failed build must not stick: the next request tries again.
    ready.catch(() => {
      if (holder[KEY]?.ready === ready) delete holder[KEY];
    });
  }
  const db = await holder[KEY].ready;
  // setDb on every call: Next can load client.ts more than once (one copy per server bundle).
  setDb(db);
  return db;
}

/** Demo only: throw the demo database away and build it again from the dataset. */
export async function resetDemoDb(): Promise<void> {
  if (!usingDemoDb()) throw new Error("Reset only works on the demo database (DATABASE_URL is set).");
  const old = holder[KEY];
  delete holder[KEY];
  setDb(null);
  if (old) {
    await old.ready.catch(() => undefined);
    await old.client?.close().catch(() => undefined);
  }
  await ensureDb();
}
