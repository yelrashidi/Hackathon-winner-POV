import type { Actor } from "@/contracts/actor";
import type { Person } from "@/contracts/audit-view";
import { recordDenied } from "@/server/core/audit";
import { authorize, Forbidden, type Action } from "@/server/core/authorize";
import type { Db, Executor } from "@/server/db/client";
import { users } from "@/server/db/schema";

/** Auditor-only gate for every read in this feature. A refused attempt is itself audited. */
export async function guard(actor: Actor, action: Extract<Action, "audit.view" | "audit.export">, db: Db, target?: { invoiceId?: string }) {
  try {
    return authorize(actor, action).actor;
  } catch (err) {
    if (err instanceof Forbidden) {
      await recordDenied(actor, { attempted: action, reason: err.reason, entityType: "invoice", entityId: target?.invoiceId ?? "-", invoiceId: null }, { db });
    }
    throw err;
  }
}

export type People = (id: string | null | undefined) => Person | null;

/** Every user (tens of rows) → lookup. Terminated users are kept, so old records still resolve. */
export async function loadPeople(db: Executor): Promise<People> {
  const rows = await db.select({ id: users.id, name: users.fullName, role: users.role }).from(users);
  const map = new Map(rows.map((r) => [r.id, { userId: r.id, name: r.name, role: r.role }]));
  return (id) => (id ? (map.get(id) ?? { userId: id, name: id, role: "unknown" }) : null);
}

/** Postgres timestamptz text → ISO 8601. */
export const iso = (v: string | Date | null | undefined): string | null => (v === null || v === undefined ? null : new Date(v).toISOString());

export class AuditNotFound extends Error {
  readonly status = 404 as const;
  constructor(message: string) {
    super(message);
    this.name = "AuditNotFound";
  }
}
