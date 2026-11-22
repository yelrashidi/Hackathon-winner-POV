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
  const client = new PGlite(abs);
  // The app runs as the restricted role, like on Postgres (no UPDATE/DELETE on audit_events).
  // PGlite runs statements in call order, so this lands before any app query.
  void client.exec("SET ROLE ap_app");
  const db = drizzlePglite(client, { schema }) as unknown as Db;
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
