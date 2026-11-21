/** Seeds an EMPTY, migrated database from the dataset as the owner.  npm run db:seed */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Db } from "@/server/db/client";
import * as schema from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed/seed";

const url = process.env.DATABASE_URL_ADMIN;
if (!url) throw new Error("DATABASE_URL_ADMIN is not set (see .env.example)");
const client = postgres(url, { max: 1, onnotice: () => {} });
try {
  console.log("seeded", await seedDatabase(drizzle(client, { schema }) as unknown as Db, { log: console.log }));
} finally {
  await client.end();
}
