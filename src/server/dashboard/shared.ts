import type { Actor } from "@/contracts/actor";
import { authorize, type Action } from "@/server/core/authorize";
import { getDb, type Db, type Executor } from "@/server/db/client";
import { departments, users } from "@/server/db/schema";

/**
 * The dashboard's read side: one query module per screen. Every read checks the same role matrix
 * as the writes (authorize), so typing a screen's URL as the wrong role gets a 403, not data.
 * Writes are never here: they go through src/server/pipeline (authorize → transaction → audit → fire).
 */

export type Opts = { db?: Db };
export const dbOf = (opts: Opts = {}): Db => opts.db ?? getDb();

export function allow(actor: Actor, ...actions: Action[]): void {
  let last: unknown;
  for (const a of actions) {
    try {
      authorize(actor, a);
      return;
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

export interface PersonRef {
  userId: string;
  name: string;
  role: string;
  title: string | null;
}

export type PeopleLookup = (id: string | null | undefined) => PersonRef | null;

export async function people(db: Executor): Promise<PeopleLookup> {
  const rows = await db.select({ id: users.id, name: users.fullName, role: users.role, title: users.title }).from(users);
  const map = new Map(rows.map((r) => [r.id, { userId: r.id, name: r.name, role: r.role, title: r.title }]));
  return (id) => (id ? (map.get(id) ?? { userId: id, name: id, role: "unknown", title: null }) : null);
}

export async function departmentNames(db: Executor): Promise<Map<string, string>> {
  const rows = await db.select({ id: departments.id, name: departments.name }).from(departments);
  return new Map(rows.map((r) => [r.id, r.name]));
}

export const iso = (v: string | Date | null | undefined): string | null => (v === null || v === undefined ? null : new Date(v).toISOString());
