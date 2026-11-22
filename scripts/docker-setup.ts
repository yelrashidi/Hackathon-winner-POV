/**
 * One-shot setup for `docker compose up`: apply pending migrations, then seed the dataset ONLY if
 * the database is empty. Safe to run on every start — a second run migrates nothing and seeds
 * nothing, so the data (and every decision made in the app) survives restarts.
 * To start over: `docker compose down -v` (drops the volume), then `docker compose up -d`.
 */
import path from "node:path";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type { Db } from "@/server/db/client";
import * as schema from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed/seed";

const url = process.env.DATABASE_URL_ADMIN;
if (!url) throw new Error("DATABASE_URL_ADMIN is not set");
const client = postgres(url, { max: 1, onnotice: () => {} });
try {
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: path.resolve("src/server/db/migrations") });
  console.log("migrations applied");

  const [row] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM vendors`);
  if ((row?.n ?? 0) > 0) {
    console.log(`already seeded (${row!.n} vendors) — nothing to do`);
  } else {
    console.log("empty database — seeding the Harborline dataset (validation + duplicates over history)…");
    console.log("seeded", await seedDatabase(db as unknown as Db, { log: console.log }));
  }
} finally {
  await client.end();
}
