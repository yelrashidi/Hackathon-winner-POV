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

export type UserStatus = "active" | "on_leave" | "terminated";

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
export const APPROVING_ROLES: ReadonlySet<UserRole> = new Set([
  "approver",
  "finance_manager",
  "controller_admin",
]);

export function displayName(ctx: Pick<ApprovalContext, "users">, userId: string | null): string {
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
