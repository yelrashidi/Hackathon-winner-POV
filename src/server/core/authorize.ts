import { Actor as ActorSchema, type Actor, type ActorRole } from "@/contracts/actor";

/**
 * Foundation — who may do what (docs/architecture/roles-and-permissions.md, "The matrix").
 *
 *   authorize(actor, action) → { actor, action }   throws Forbidden (403 + a reason the UI shows)
 *   can(actor, action)       → boolean             for the UI to decide what to show — cosmetic only
 *
 * This file is the ROLE matrix. Rules that need data (no approving your own request, no releasing
 * what you approved, two people for a bank change) live with the feature that has the data —
 * approvals' checkDecision(), payments' release check — and call authorize() first.
 *
 * Callers use the returned `actor` / `action` for what they write (docs/rules/backend.md,
 * BUG-Youssef-05), not separate arguments.
 */

export const ACTIONS = {
  "invoice.submit": ["employee", "ap_clerk", "approver", "finance_manager", "controller_admin"],
  /** Ingest inbox, review extraction, edit fields, code lines. */
  "invoice.review": ["ap_clerk", "controller_admin"],
  "flag.resolve": ["ap_clerk", "controller_admin"],
  "flag.override": ["ap_clerk", "controller_admin"],
  "approval.decide": ["approver", "finance_manager", "controller_admin"],
  "payment.prepare": ["ap_clerk", "finance_manager", "controller_admin"],
  "payment.release": ["finance_manager", "controller_admin"],
  "vendor.bank_change.request": ["ap_clerk", "finance_manager", "controller_admin"],
  "vendor.bank_change.verify": ["finance_manager", "controller_admin"],
  "admin.edit": ["controller_admin"],
  /**
   * The audit dashboard (invoice list + invoice detail) and its export. Auditor ONLY, as the team
   * decided on 2026-11-21. Note: roles-and-permissions.md also lists the Controller for "view full
   * audit log" — add "controller_admin" here if the team keeps that row.
   */
  "audit.view": ["auditor"],
  "audit.export": ["auditor"],
} as const satisfies Record<string, readonly ActorRole[]>;

export type Action = keyof typeof ACTIONS;

const LABELS: Record<Action, string> = {
  "invoice.submit": "submit invoices",
  "invoice.review": "review and code invoices",
  "flag.resolve": "resolve flags",
  "flag.override": "override flags",
  "approval.decide": "approve or reject invoices",
  "payment.prepare": "schedule payments",
  "payment.release": "release payments",
  "vendor.bank_change.request": "request vendor bank changes",
  "vendor.bank_change.verify": "verify vendor bank changes",
  "admin.edit": "edit users, roles and policies",
  "audit.view": "view the audit log",
  "audit.export": "export the audit log",
};

export class Forbidden extends Error {
  readonly status = 403 as const;
  constructor(
    readonly action: string,
    readonly reason: string,
  ) {
    super(reason);
    this.name = "Forbidden";
  }
}

export function can(actor: Actor, action: Action): boolean {
  const parsed = ActorSchema.safeParse(actor);
  if (!parsed.success) return false;
  return (ACTIONS[action] as readonly string[]).includes(parsed.data.role);
}

export function authorize(actor: Actor, action: Action): { actor: ReturnType<typeof ActorSchema.parse>; action: Action } {
  const parsed = ActorSchema.safeParse(actor);
  if (!parsed.success) throw new Forbidden(action, "You are not signed in.");
  if (!(ACTIONS[action] as readonly string[]).includes(parsed.data.role)) {
    throw new Forbidden(action, `Your role (${parsed.data.role}) cannot ${LABELS[action]}.`);
  }
  return { actor: parsed.data, action };
}
