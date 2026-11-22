/**
 * One-shot setup for `docker compose up`: apply pending migrations, then build the demo's starting
 * point ONLY if the database is empty — the dataset's history plus its AP inbox through intake, the
 * same as the no-Docker demo and the Admin's "Reset demo data" (buildDemoBaseline). Safe to run on every start — a second run migrates nothing and seeds
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
import { buildDemoBaseline } from "@/server/demo/reset";

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
    console.log("empty database — building the demo: dataset history (validation + duplicates) and the AP inbox through intake…");
    console.log("seeded", await db.transaction((tx) => buildDemoBaseline(tx as unknown as Db)));
  }
} finally {
  await client.end();
}
