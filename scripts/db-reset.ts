/**
 * Local only: drops everything, migrates, seeds.  npm run db:reset
 * Refuses to run against anything that is not localhost, so it can never wipe a deployed audit log.
 */
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type { Db } from "@/server/db/client";
import * as schema from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed/seed";

const url = process.env.DATABASE_URL_ADMIN;
if (!url) throw new Error("DATABASE_URL_ADMIN is not set (see .env.example)");
const host = new URL(url).hostname;
if (!["localhost", "127.0.0.1", "db"].includes(host) && process.env.ALLOW_DB_RESET !== "yes") {
  throw new Error(`Refusing to reset a non-local database (${host}). Set ALLOW_DB_RESET=yes if you really mean it.`);
}
const client = postgres(url, { max: 1, onnotice: () => {} });
try {
  await client.unsafe("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;");
  await migrate(drizzle(client), { migrationsFolder: path.resolve("src/server/db/migrations") });
  console.log("migrated");
  const counts = await seedDatabase(drizzle(client, { schema }) as unknown as Db, { log: console.log });
  console.log("seeded", counts);
} finally {
  await client.end();
}
