import { sql } from "drizzle-orm";
import { bigserial, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { invoices, payments } from "./pipeline";
import { users } from "./reference";

/**
 * The audit log: one row per action, append-only.
 *
 * Who could change history, and why they can't:
 *   - the app connects as `ap_app`, which has no UPDATE / DELETE / TRUNCATE on this table and may
 *     only INSERT the columns below except `id` and `occurred_at` — so it cannot backdate a row
 *     (migration 0001_audit_guards.sql);
 *   - a trigger rejects UPDATE / DELETE / TRUNCATE for every role, the owner included.
 * Rows are written by core/audit.ts in the SAME transaction as the change they describe, so a
 * change without its audit row (or the reverse) cannot exist.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** Database clock, not the app's: the app role cannot set this column. */
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" }).notNull().default(sql`now()`),
    /** Groups the events written by one user action (one transaction). */
    requestId: uuid("request_id").notNull(),
    /** The person (or the `system` user) who did it. For a delegate: the delegate. */
    actorId: text("actor_id").notNull().references(() => users.id),
    /** Their role at the time — roles change, history must not. */
    actorRole: text("actor_role").notNull(),
    /** For a delegate action: the absent person they acted for. */
    onBehalfOf: text("on_behalf_of").references(() => users.id),
    /** Dotted verb from AUDIT_ACTIONS (src/contracts/audit.ts), e.g. `flag.overridden`. */
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    invoiceId: text("invoice_id").references(() => invoices.id),
    paymentId: text("payment_id").references(() => payments.id),
    before: jsonb("before"),
    after: jsonb("after"),
    /** Why: the override note, the rejection comment, "seeded from Harborline history". */
    reason: text("reason"),
    metadata: jsonb("metadata").notNull().default({}),
  },
  (t) => [
    index("audit_events_invoice_idx").on(t.invoiceId, t.occurredAt),
    index("audit_events_payment_idx").on(t.paymentId, t.occurredAt),
    index("audit_events_entity_idx").on(t.entityType, t.entityId),
    index("audit_events_actor_idx").on(t.actorId, t.occurredAt),
    index("audit_events_occurred_idx").on(t.occurredAt),
  ],
);
