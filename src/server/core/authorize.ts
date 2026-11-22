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
  /**
   * Ingest inbox, review extraction, edit fields, code lines ("the checks"). The team's dashboard
   * plan (2026-11-21): access widens with seniority — managers and the Finance Manager can do the
   * clerk's checks too. Separation of duties still holds at approval: whoever submits an invoice is
   * excluded from approving it (approvals' route.ts), so doing the checks never lets you approve your own work.
   */
  "invoice.review": ["ap_clerk", "approver", "finance_manager", "controller_admin"],
  "flag.resolve": ["ap_clerk", "approver", "finance_manager", "controller_admin"],
  "flag.override": ["ap_clerk", "approver", "finance_manager", "controller_admin"],
  "approval.decide": ["approver", "finance_manager", "controller_admin"],
  /**
   * Scheduling: the AP Clerk's job (policy P09 "AP clerks prepare, they cannot release"; all 415
   * historical payments were prepared by a clerk). The Finance Manager keeps it as a BACKUP when no
   * clerk is available (the Controller too on the server, though the dashboard gives the Admin no
   * scheduling page) — separation still holds, because whoever scheduled a payment
   * can never release it (payments' SCHEDULED_IT check + the payments CHECK constraint), so a
   * payment the FM schedules goes to the Controller to release. Decided 2026-11-21 (Andrew).
   */
  "payment.prepare": ["ap_clerk", "finance_manager", "controller_admin"],
  "payment.release": ["finance_manager", "controller_admin"],
  /**
   * Feature 9 — vendor master. Anyone in finance may stop a vendor (hold, the safe direction);
   * only a manager lets one be paid (approve, lift a hold, verify bank details). The "two people"
   * rules (not the onboarder, not the requester) need data, so they live in features/vendors/rules.ts.
   */
  "vendor.view": ["ap_clerk", "finance_manager", "controller_admin", "auditor"],
  "vendor.onboard": ["ap_clerk", "finance_manager", "controller_admin"],
  "vendor.approve": ["finance_manager", "controller_admin"],
  "vendor.hold": ["ap_clerk", "finance_manager", "controller_admin"],
  "vendor.release_hold": ["finance_manager", "controller_admin"],
  "vendor.bank_change.request": ["ap_clerk", "finance_manager", "controller_admin"],
  /** Verify or reject a pending bank change. */
  "vendor.bank_change.verify": ["finance_manager", "controller_admin"],
  "admin.edit": ["controller_admin"],
  /**
   * Read-only invoice records (the invoice, its document, coding, approvals, payments and who did
   * what), per the matrix's "View invoices" row. Every role may ask; features/invoices narrows it:
   * an employee sees their own submissions, an approver their own department, everyone else all.
   */
  "invoice.view": ["employee", "ap_clerk", "approver", "finance_manager", "controller_admin", "auditor"],
  /**
   * The full audit log (every event with before / after, control checks) and its export: the
   * Auditor ("read-only everything, audit export") and the Controller/Admin ("full audit log"),
   * per product.md and the roles matrix. Nobody else reads the audit log itself.
   */
  "audit.view": ["controller_admin", "auditor"],
  "audit.export": ["controller_admin", "auditor"],
  /**
   * Bonus: export approved bills + settled payments as an accounting journal (posting to the books).
   * The people who own the books — Finance Manager and Controller/Admin — decide what is posted and when.
   */
  "journal.export": ["finance_manager", "controller_admin"],
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
  "vendor.view": "view the vendor master",
  "vendor.onboard": "onboard vendors",
  "vendor.approve": "approve new vendors",
  "vendor.hold": "put vendors on hold",
  "vendor.release_hold": "lift a vendor hold",
  "vendor.bank_change.request": "request vendor bank changes",
  "vendor.bank_change.verify": "verify vendor bank changes",
  "admin.edit": "edit users, roles and policies",
  "invoice.view": "view invoices",
  "audit.view": "view the audit log",
  "audit.export": "export the audit log",
  "journal.export": "export the accounting journal",
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
