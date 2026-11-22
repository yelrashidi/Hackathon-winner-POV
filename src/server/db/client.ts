import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * The database handle. Server code only — the browser never talks to the database.
 *
 *   getDb()   the app's connection, as the restricted `ap_app` role (DATABASE_URL). Lazy: nothing
 *             connects at import time, so tests and scripts that never touch the DB stay offline.
 *   Db / Tx   driver-independent types: the same services run on postgres.js in the app and on
 *             PGlite (in-process Postgres) in tests.
 *
 * DATABASE_URL=pglite:<folder> runs the app on an EMBEDDED Postgres (PGlite) stored in that folder:
 * a demo with no Docker and no server. `npm run demo` creates, migrates and seeds it, then starts
 * the app with that URL. Same schema, migrations and `ap_app` role as the real database.
 */

export type Schema = typeof schema;
export type Db = PgDatabase<PgQueryResultHKT, Schema>;
export type Tx = PgTransaction<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;
/** Anything a query can run on: the database or an open transaction. */
export type Executor = Db | Tx;

let appDb: Db | null = null;

/** Connects with `url`. Deployed on Supabase from serverless functions, pass the POOLED string. */
export function connect(url: string, opts: { max?: number } = {}): Db {
  // prepare:false — Supabase's transaction pooler does not support prepared statements.
  const client = postgres(url, { max: opts.max ?? 5, prepare: false });
  return drizzle(client, { schema }) as unknown as Db;
}

export const PGLITE_SCHEME = "pglite:";

/** The restricted role the app runs as: no UPDATE / DELETE / TRUNCATE on audit_events (0001). */
export const APP_ROLE = "ap_app";

/**
 * Wraps a PGlite client so the app can only ever run as `ap_app`. PGlite opens as the superuser,
 * so the client switches role first, and EVERY query, exec and transaction waits for that switch
 * and the `current_user` check. If either fails (role missing, database not migrated), every query
 * rejects with the reason: the app never silently runs as superuser and bypasses the audit guards.
 */
export function restrictToAppRole(client: PGlite): PGlite {
  const ready = (async () => {
    try {
      await client.exec(`SET ROLE ${APP_ROLE}`);
    } catch (err) {
      throw new Error(`Embedded database: could not switch to role ${APP_ROLE} (${err instanceof Error ? err.message : String(err)}). Run \`npm run demo -- --reset\`.`);
    }
    const { rows } = await client.query<{ u: string }>("SELECT current_user AS u");
    if (rows[0]?.u !== APP_ROLE) throw new Error(`Embedded database: running as ${rows[0]?.u ?? "unknown"}, expected ${APP_ROLE}; refusing to run.`);
  })();
  ready.catch(() => {}); // surfaced through every query below, not as an unhandled rejection

  // A wrapper, not a patch: PGlite's own methods call each other internally and must not wait on
  // `ready` themselves. Only calls coming from the app (through drizzle) are gated.
  const gated = new Set<PropertyKey>(["exec", "query", "transaction"]);
  return new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== "function") return value;
      const fn = (value as (...a: unknown[]) => unknown).bind(target);
      return gated.has(prop) ? async (...args: unknown[]) => (await ready, fn(...args)) : fn;
    },
  });
}

/** A drizzle handle on an embedded database folder, restricted to `ap_app`. No caching. */
export function openEmbeddedDb(dir: string): { db: Db; client: PGlite } {
  const client = restrictToAppRole(new PGlite(path.resolve(dir)));
  return { db: drizzlePglite(client, { schema }) as unknown as Db, client };
}

/**
 * The embedded database in `dir`, opened once per process. PGlite has no file lock, so two
 * instances on one folder would corrupt it — and Next.js can load this module more than once
 * (BUG-Katie-01) — so the instance lives on globalThis.
 */
function openEmbedded(dir: string): Db {
  const g = globalThis as { __harborlinePglite?: { dir: string; db: Db } };
  const abs = path.resolve(dir);
  if (g.__harborlinePglite) {
    if (g.__harborlinePglite.dir !== abs) throw new Error(`Embedded database already open at ${g.__harborlinePglite.dir}`);
    return g.__harborlinePglite.db;
  }
  const { db } = openEmbeddedDb(abs);
  g.__harborlinePglite = { dir: abs, db };
  return db;
}

export function getDb(): Db {
  if (appDb) return appDb;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (see .env.example; `npm run demo` runs without Docker)");
  appDb = url.startsWith(PGLITE_SCHEME) ? openEmbedded(url.slice(PGLITE_SCHEME.length)) : connect(url);
  return appDb;
}

/** Tests: run the app's services against another database (e.g. PGlite). */
export function setDb(db: Db | null): void {
  appDb = db;
}
