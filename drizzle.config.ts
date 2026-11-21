import { defineConfig } from "drizzle-kit";

// Migrations use the DIRECT / owner connection (docs/rules/db.md); the app uses DATABASE_URL (ap_app).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema/index.ts",
  out: "./src/server/db/migrations",
  dbCredentials: { url: process.env.DATABASE_URL_ADMIN ?? "postgres://postgres:postgres@localhost:5432/harborline" },
  strict: true,
});
