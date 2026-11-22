import { z } from "zod";

/**
 * Feature 8 — one audit event = one `audit_events` row (src/server/db/schema/audit.ts).
 * Written ONLY through core/audit.ts, inside the transaction of the change it describes.
 * The actor, time and request id are not part of this input: the emitter takes the actor from
 * the server session and the database stamps the time.
 */

/**
 * Every action the audit log knows. Closed on purpose: the auditor's filters and the CSV export
 * rely on these strings, so a new one is added here (an optional, non-breaking contract change).
 */
export const AUDIT_ACTIONS = [
  // invoice lifecycle
  "invoice.imported", // historical row loaded by the seed
  "invoice.created", // intake / extraction produced it
  "invoice.edited", // a human changed fields (material edits bump the version)
  "invoice.validated", // validation ran: snapshot of the reference data the verdict used
  "invoice.coding_suggested", // coding proposed an account + department per line (system)
  "invoice.line_coded", // a person accepted or changed a line's GL / department
  "invoice.status_changed", // fire(): every state-machine transition
  // flags
  "flag.raised",
  "flag.reopened", // raised again after being resolved
  "flag.auto_resolved", // re-validation no longer raises it
  "flag.resolved", // a person fixed the cause
  "flag.overridden", // a person accepted it without fixing it (note required)
  // approvals
  "approval.routed", // a plan was made
  "approval.decided", // a step approved / rejected (acted_by + on_behalf_of)
  // payments (names as emitted by src/server/features/payments)
  "payment.scheduled",
  "payment.on_hold",
  "payment.hold_released",
  "payment.released",
  "payment.settled",
  "payment.failed",
  "payment.cancelled",
  "payment.retried",
  "payment_flag.created",
  "payment_flag.cleared",
  "payment_flag.cleared_automatically",
  // vendor master + bank accounts (bank_account.* as emitted by payments' bank-change flow)
  "vendor.created",
  "vendor.status_changed",
  "bank_account.change_requested",
  "bank_account.verified",
  "bank_account.rejected",
  "bank_account.closed",
  "policy.edited",
  "user.role_changed",
  "user.status_changed", // on leave + delegate (P08), or back to active — the Admin's people screen
  // security
  "authz.denied", // a refused attempt (written in its own transaction)
] as const;
export const AuditAction = z.enum(AUDIT_ACTIONS);
export type AuditAction = z.infer<typeof AuditAction>;

export const AuditEntityType = z.enum(["invoice", "invoice_flag", "invoice_line", "approval_plan", "approval_step", "payment", "payment_flag", "vendor", "bank_account", "approval_policy", "user"]);
export type AuditEntityType = z.infer<typeof AuditEntityType>;

/** A JSON object snapshot (a row, or just the fields that matter). */
const Snapshot = z.record(z.string(), z.unknown());

export const AuditEventInput = z.object({
  action: AuditAction,
  entityType: AuditEntityType,
  entityId: z.string().min(1),
  /** Set whenever the event concerns an invoice, so the invoice's timeline is one indexed query. */
  invoiceId: z.string().min(1).nullable().default(null),
  paymentId: z.string().min(1).nullable().default(null),
  /** State before / after the change. The UI computes the diff; null for a creation / deletion. */
  before: Snapshot.nullable().default(null),
  after: Snapshot.nullable().default(null),
  /** Why — override note, rejection comment, import source. Required where policy demands a reason. */
  reason: z.string().trim().min(1).nullable().default(null),
  /** Context that is not the entity itself: invoice_version, rule-set version, ip, … */
  metadata: Snapshot.default({}),
});
export type AuditEventInput = z.input<typeof AuditEventInput>;
export type AuditEvent = z.output<typeof AuditEventInput>;
