/** Applies pending migrations as the owner (DATABASE_URL_ADMIN).  npm run db:migrate */
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL_ADMIN;
if (!url) throw new Error("DATABASE_URL_ADMIN is not set (see .env.example)");
const client = postgres(url, { max: 1, onnotice: () => {} });
try {
  await migrate(drizzle(client), { migrationsFolder: path.resolve("src/server/db/migrations") });
  console.log("migrations applied");
} finally {
  await client.end();
}
