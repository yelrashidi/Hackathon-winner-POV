import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, describe, expect, it } from "vitest";
import { openEmbeddedDb } from "../client";
import { MIGRATIONS_DIR } from "./helpers";

/**
 * The no-Docker demo database (DATABASE_URL=pglite:…): the app must run as `ap_app`, never as the
 * superuser PGlite opens with — otherwise the audit guards (no UPDATE/DELETE) silently vanish.
 */

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(path.join(tmpdir(), "hl-pglite-"));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const rowsOf = <T>(r: unknown) => (r as { rows: T[] }).rows;

describe("embedded database role", () => {
  it("runs as ap_app from the very first query, and audit history cannot be deleted", { timeout: 60_000 }, async () => {
    const dir = tempDir();
    const owner = new PGlite(dir);
    await migrate(drizzle(owner), { migrationsFolder: MIGRATIONS_DIR });
    await owner.close();

    const { db, client } = openEmbeddedDb(dir);
    // No awaiting of any setup step: the first query must already see the restricted role.
    expect(rowsOf<{ u: string }>(await db.execute(sql`SELECT current_user AS u`))[0]!.u).toBe("ap_app");
    await expect(db.execute(sql`DELETE FROM audit_events`)).rejects.toThrow();
    await expect(db.transaction(async (tx) => tx.execute(sql`TRUNCATE audit_events`))).rejects.toThrow();
    await client.close();
  });

  it("refuses every query when the role cannot be set (unmigrated folder), instead of running as superuser", { timeout: 60_000 }, async () => {
    const { db, client } = openEmbeddedDb(tempDir());
    // drizzle wraps it as "Failed query: …"; the reason is the cause (or the error itself).
    const reason = async (p: Promise<unknown>) => {
      const err = (await p.then(() => null, (e: unknown) => e)) as { message?: string; cause?: { message?: string } } | null;
      return `${err?.message ?? "resolved"} ${err?.cause?.message ?? ""}`;
    };
    expect(await reason(db.execute(sql`SELECT 1`))).toMatch(/could not switch to role ap_app/);
    expect(await reason(db.transaction(async (tx) => tx.execute(sql`SELECT 1`)))).toMatch(/could not switch to role ap_app/);
    await client.close();
  });
});
