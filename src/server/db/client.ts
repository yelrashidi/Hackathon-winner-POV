import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
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

export function getDb(): Db {
  if (appDb) return appDb;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
  appDb = connect(url);
  return appDb;
}

/** Tests: run the app's services against another database (e.g. PGlite). */
export function setDb(db: Db | null): void {
  appDb = db;
}
