import type { UserRole } from "./users";

/**
 * The six roles of the brief (docs/brief.md: every user has one of six roles). Access widens with seniority:
 *
 *   employee  Employee          read-only: the bills they requested ("My bills") and where each one is.
 *                               Bills reach AP from suppliers, so there is no "submit" screen; the AP
 *                               Clerk records the employee as the requester during the checks
 *   clerk     AP Clerk          the checks (what extraction or coding could not settle), uploads, schedules payments
 *   manager   Operations Mgr.   + approves their department's bills (dataset policy: up to $10,000 CAD;
 *                               every department manager is in this group, Dev Malhotra runs Operations)
 *   finance   Finance Manager   + approves above $10,000 and flagged / new-vendor bills, releases payments ≤ $100,000
 *   admin     Admin             everything except payments: checks, approvals, vendors, users and policies;
 *                               releases only what the brief gives the Controller (P10/P11)
 *   auditor   Auditor           every invoice and its audit trail, read-only, plus the export
 *
 * The role always comes from the employee record on the server; this file only names and groups it.
 */
export type AppRole = "employee" | "clerk" | "manager" | "finance" | "admin" | "auditor";

export const APP_ROLE: Partial<Record<UserRole, AppRole>> = {
  employee: "employee",
  ap_clerk: "clerk",
  approver: "manager",
  finance_manager: "finance",
  controller_admin: "admin",
  auditor: "auditor",
};

export const appRoleOf = (role: string | null | undefined): AppRole | null => (role ? (APP_ROLE[role as UserRole] ?? null) : null);

export const APP_ROLES: { key: AppRole; label: string; summary: string; can: string[] }[] = [
  {
    key: "employee",
    label: "Employee",
    summary: "Follows the bills they asked for: where each one is, who approved it, when it was paid. Changes nothing.",
    can: ["See the bills you requested and where each one is", "Who checked, approved and paid each one, and when", "Read-only: suppliers send bills to AP, not to you"],
  },
  {
    key: "clerk",
    label: "AP Clerk",
    summary: "Checks what the machine couldn't read or code, then sends bills to approval.",
    can: ["Check and code incoming bills", "Type in bills that couldn't be read", "Schedule approved bills for payment"],
  },
  {
    key: "manager",
    label: "Operations Manager",
    summary: "Approves their department's bills, and can do the clerk's checks.",
    can: ["Everything the AP Clerk checks", "Approve your department's bills up to $10,000 CAD", "Never a bill you requested or submitted"],
  },
  {
    key: "finance",
    label: "Finance Manager",
    summary: "Approves larger and flagged bills and releases payments.",
    can: ["Checks and approvals at any amount routed to you", "Release payments up to $100,000 CAD", "Verify a vendor's new bank details"],
  },
  {
    key: "admin",
    label: "Admin",
    summary: "Runs everything except payments: approvals over $50,000, vendors, people and policies.",
    can: ["Checks, approvals, vendors", "Edit approval policies, put people on leave", "Releases payments of any amount"],
  },
  {
    key: "auditor",
    label: "Auditor",
    summary: "Reads every invoice and its full audit trail. Changes nothing.",
    can: ["Every invoice and its audit trail", "Export the audit log", "Read-only"],
  },
];

export const roleInfo = (key: AppRole) => APP_ROLES.find((r) => r.key === key)!;
