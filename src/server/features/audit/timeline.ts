import { asc, eq, or } from "drizzle-orm";
import type { TimelineEvent } from "@/contracts/audit-view";
import type { Executor } from "@/server/db/client";
import { auditEvents } from "@/server/db/schema";
import { iso, type People } from "./shared";

/**
 * The invoice's audit trail: every event about the invoice or any of its payments, oldest first,
 * each with a sentence a person can read ("Dev Malhotra (approver) approved step 1").
 */

type Row = typeof auditEvents.$inferSelect;
type Obj = Record<string, unknown> | null;

const str = (o: Obj, k: string) => (o && o[k] !== undefined && o[k] !== null ? String(o[k]) : "");

export function describeEvent(e: Row, people: People): string {
  const who = people(e.actorId);
  const actor = `${who?.name ?? e.actorId} (${e.actorRole})`;
  const behalf = e.onBehalfOf ? ` on behalf of ${people(e.onBehalfOf)?.name ?? e.onBehalfOf}` : "";
  const before = e.before as Obj;
  const after = e.after as Obj;
  const why = e.reason ? ` — "${e.reason}"` : "";
  switch (e.action) {
    case "invoice.imported":
      return `Imported from history with status ${str(after, "status")}${str(after, "legacyStatus") ? ` (source: ${str(after, "legacyStatus")})` : ""}`;
    case "invoice.created":
      return `${actor} received the invoice via ${str(after, "source")}`;
    case "invoice.edited": {
      const changed = Object.keys(after ?? {}).filter((k) => JSON.stringify(before?.[k] ?? null) !== JSON.stringify(after?.[k] ?? null));
      return `${actor} changed ${changed.join(", ") || "nothing"}${why}`;
    }
    case "invoice.validated": {
      const flags = (after?.flags as unknown[] | undefined)?.length ?? 0;
      return `Validation ran on version ${str(after, "invoiceVersion")}: ${flags} flag(s)${after?.blocking ? ", blocking" : ""}`;
    }
    case "invoice.status_changed":
      return `${actor}${behalf} moved the invoice ${str(before, "status")} → ${str(after, "status")}${why}`;
    case "invoice.coding_suggested":
      return `Coding suggested accounts for ${((after?.lines as unknown[] | undefined) ?? []).length} line(s)${after?.journalBalanced === false ? " — journal does not balance" : ""}`;
    case "invoice.line_coded":
      return `${actor} ${str(after, "codingSource") === "changed" ? "changed" : "accepted"} line ${str(after, "lineNo")}: GL ${str(after, "glAccountCode")}, dept ${str(after, "departmentId")}${why}`;
    case "flag.raised":
      return (e.metadata as Obj)?.refreshed ? `Flag ${str(after, "code")} updated: ${str(after, "message")}` : `Flag raised: ${str(after, "code")} (${str(after, "severity")}) — ${str(after, "message")}`;
    case "flag.reopened":
      return `Flag ${str(after, "code")} raised again after being resolved`;
    case "flag.auto_resolved":
      return `Flag ${str(before, "code")} cleared: no longer raised by ${str(e.metadata as Obj, "source") || "validation"}`;
    case "flag.resolved":
      return `${actor} resolved flag ${str(before, "code")}${why}`;
    case "flag.overridden":
      return `${actor} OVERRODE flag ${str(before, "code")} (${str(before, "severity")})${why}`;
    case "approval.routed":
      return `Approval routed: ${str(after, "steps")} step(s)`;
    case "approval.decided":
      return `${actor}${behalf} ${str(after, "decision")} step ${str(after, "seq")}${why}`;
    case "payment.scheduled":
      return `${actor} scheduled payment ${e.paymentId ?? e.entityId}`;
    case "payment.released":
      return `${actor} released payment ${e.paymentId ?? e.entityId}`;
    case "payment.settled":
      return `Payment ${e.paymentId ?? e.entityId} settled`;
    case "payment.failed":
    case "payment.cancelled":
      return `${actor} — payment ${e.paymentId ?? e.entityId} ${e.action.split(".")[1]}${why}`;
    case "payment.on_hold":
      return `${actor} put payment ${e.paymentId ?? e.entityId} on hold${why}`;
    case "payment.hold_released":
      return `${actor} took payment ${e.paymentId ?? e.entityId} off hold${why}`;
    case "payment.retried":
      return `${actor} scheduled a new attempt for payment ${e.paymentId ?? e.entityId}${why}`;
    case "payment_flag.created":
      return `Payment flag raised: ${str(after, "reasonCode")} (${str(after, "urgency")})${why}`;
    case "payment_flag.cleared":
      return `${actor} cleared payment flag ${str(before, "reasonCode") || e.entityId}${why}`;
    case "payment_flag.cleared_automatically":
      return `Payment flag ${str(before, "reasonCode") || e.entityId} cleared automatically${why}`;
    case "bank_account.change_requested":
      return `${actor} requested a bank-account change${why}`;
    case "bank_account.verified":
      return `${actor} verified a bank account${why}`;
    case "bank_account.rejected":
      return `${actor} rejected a bank-account change${why}`;
    case "bank_account.closed":
      return `${actor} closed a bank account${why}`;
    case "authz.denied":
      return `${actor} was REFUSED: ${e.reason ?? ""}`;
    default:
      return `${actor}${behalf}: ${e.action}${why}`;
  }
}

export function toTimelineEvent(e: Row, people: People): TimelineEvent {
  return {
    id: e.id,
    occurredAt: iso(e.occurredAt)!,
    action: e.action,
    summary: describeEvent(e, people),
    actor: people(e.actorId)!,
    actorRoleAtTime: e.actorRole,
    onBehalfOf: people(e.onBehalfOf),
    entityType: e.entityType,
    entityId: e.entityId,
    paymentId: e.paymentId,
    before: (e.before as Obj) ?? null,
    after: (e.after as Obj) ?? null,
    reason: e.reason,
    imported: (e.metadata as Obj)?.imported === true,
    requestId: e.requestId,
  };
}

export async function invoiceTimeline(db: Executor, invoiceId: string, paymentIds: readonly string[], people: People): Promise<{ events: TimelineEvent[]; rows: Row[] }> {
  const rows = await db
    .select()
    .from(auditEvents)
    .where(or(eq(auditEvents.invoiceId, invoiceId), ...paymentIds.map((p) => eq(auditEvents.paymentId, p))))
    .orderBy(asc(auditEvents.occurredAt), asc(auditEvents.id));
  return { events: rows.map((r) => toTimelineEvent(r, people)), rows };
}
