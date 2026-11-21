import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Db } from "../client";
import * as schema from "../schema";

export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../migrations");

/** A fresh in-process Postgres with every migration applied. Connected as the owner (superuser). */
export async function createTestDb(): Promise<{ db: Db; client: PGlite }> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return { db: db as unknown as Db, client };
}

/** A migrated + seeded database. `validateHistory: false` skips the 426 validation runs. */
export async function createSeededDb(opts: { validateHistory?: boolean } = {}): Promise<{ db: Db; client: PGlite; counts: Record<string, number> }> {
  const { seedDatabase } = await import("../seed/seed");
  const { db, client } = await createTestDb();
  const counts = await seedDatabase(db, { validateHistory: opts.validateHistory ?? false });
  return { db, client, counts };
}
