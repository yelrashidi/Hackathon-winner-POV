/**
 * The demo without Docker:   npm run demo          → http://localhost:3000
 *
 *   1. Embedded Postgres (PGlite) in .data/pglite: on the first run it is created, migrated and
 *      seeded with the Harborline dataset (validation + duplicates over history, ~1 minute).
 *      Later runs reuse it, so decisions made in the app survive restarts.
 *   2. Starts the app with DATABASE_URL=pglite:.data/pglite (src/server/db/client.ts).
 *
 *   npm run demo -- --reset     wipe the embedded database and seed it again
 *   npm run demo -- --setup     only prepare the database, don't start the app
 *   npm run demo -- --start     production server (`next start`; run `npm run build` first)
 *
 * Only one process may have the folder open (PGlite has no lock): stop `npm run dev` / other
 * demo servers first. Next.js already refuses a second dev server in the same folder.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Db } from "@/server/db/client";
import * as schema from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed/seed";

const DIR = path.resolve(".data/pglite");
const READY = path.join(DIR, ".harborline-seeded");
const args = new Set(process.argv.slice(2));

if (args.has("--reset")) {
  rmSync(DIR, { recursive: true, force: true });
  console.log("embedded database removed");
}

// Never open the folder if it is already seeded: another running server may hold it.
if (existsSync(READY)) {
  console.log(`embedded database ready (${path.relative(process.cwd(), DIR)})`);
} else {
  rmSync(DIR, { recursive: true, force: true }); // a half-finished earlier attempt
  mkdirSync(DIR, { recursive: true });
  console.log("creating the embedded database — first run takes about a minute…");
  const client = new PGlite(DIR);
  try {
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: path.resolve("src/server/db/migrations") });
    console.log("migrations applied");
    const counts = await seedDatabase(db as unknown as Db, { log: console.log });
    console.log("seeded", counts);
  } finally {
    await client.close();
  }
  writeFileSync(READY, new Date().toISOString());
}

if (!args.has("--setup")) {
  const mode = args.has("--start") ? "start" : "dev";
  console.log(`starting the app (next ${mode}) on the embedded database…`);
  const child = spawn("npx", ["next", mode], {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, DATABASE_URL: `pglite:${path.relative(process.cwd(), DIR)}` },
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}
