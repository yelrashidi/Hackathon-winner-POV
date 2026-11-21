import type { ApprovalPolicy } from "@/contracts/approvals";

/**
 * The reference data approvals reads. Shaped like the seeded `users`, `departments` and `vendors`
 * tables (docs/architecture/data-model.md) so a DB query maps straight onto it. Kept separate from
 * the ORM so the routing logic stays pure and unit-testable.
 */

export type UserRole =
  | "employee"
  | "ap_clerk"
  | "approver"
  | "finance_manager"
  | "controller_admin"
  | "auditor";

/** active | on_leave | terminated. Anything else (e.g. "suspended") is treated as unavailable. */
export type UserStatus = "active" | "on_leave" | "terminated" | (string & {});

export interface DirectoryUser {
  id: string;
  fullName: string;
  role: UserRole;
  departmentId: string;
  managerId: string | null;
  approvalLimitCents: number;
  status: UserStatus;
  statusSince: string | null;
  delegateId: string | null;
}

export interface DirectoryDepartment {
  id: string;
  name: string;
  managerId: string;
  /** departments.annual_budget_cad in cents; null if not set. */
  annualBudgetCents: number | null;
}

export interface DirectoryVendor {
  id: string;
  legalName: string;
  category: string;
  /** active | pending_review | on_hold, plus anything feature 9 adds (treated as not payable). */
  status: string;
  requiresPo: boolean;
  /** ISO date. */
  onboardedAt: string | null;
}

export interface ApprovalContext {
  users: ReadonlyMap<string, DirectoryUser>;
  departments: ReadonlyMap<string, DirectoryDepartment>;
  vendors: ReadonlyMap<string, DirectoryVendor>;
  /** Active and inactive rows; inactive ones are ignored. */
  policies: readonly ApprovalPolicy[];
  /** "Today" for the new-vendor window. Pass the clock in so tests are deterministic. */
  asOf: Date;
}

/** Roles that may hold an approval step. Anyone else is skipped up the manager chain. */
export const APPROVING_ROLES: ReadonlySet<string> = new Set(["approver", "finance_manager", "controller_admin"]);

/** Roles that may request a purchase (permission matrix: everyone except the auditor). */
export const REQUESTING_ROLES: ReadonlySet<string> = new Set([
  "employee",
  "ap_clerk",
  "approver",
  "finance_manager",
  "controller_admin",
]);

/** Vendor statuses an invoice may be routed and approved for. */
export const ROUTABLE_VENDOR_STATUSES: ReadonlySet<string> = new Set(["active", "pending_review"]);

export function displayName(ctx: Pick<ApprovalContext, "users">, userId: string | null | undefined): string {
  if (!userId) return "nobody";
  const u = ctx.users.get(userId);
  return u ? `${u.fullName} (${u.id})` : userId;
}

export function formatCad(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-CA");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

/** Text that came from an invoice is data: keep it short in messages. React escapes it on render. */
export function clip(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
