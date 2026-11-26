// Which payments pages each person sees, and whether they can act. It mirrors the app-wide list in
// app/_lib/nav.ts (the sidebar), and every payments page checks it on the server. Per the brief and
// approval_policies.csv: AP Clerks prepare (schedule) payments, the Finance Manager releases up to
// $100,000 CAD, and the Admin (Controller) or the CFO release any amount, never what they approved (P10/P11).
// The CFO holds the same data role as the Controller (controller_admin), so both are "controller" here.

import { isCfo } from "@/server/session/roles";
import type { DirectoryUser, UserRole } from "@/server/session/users";

/** How the dashboard groups people, derived on the server from the employee record's role. */
export type DashboardRole = "clerk" | "finance_manager" | "controller" | "auditor" | "viewer";

export function dashboardRole(user: DirectoryUser | null): DashboardRole {
  switch (user?.role) {
    case "ap_clerk":
      return "clerk";
    case "finance_manager":
      return "finance_manager";
    case "controller_admin":
      return "controller";
    case "auditor":
      return "auditor";
    default:
      return "viewer"; // employees, approvers, and nobody picked
  }
}

export const ROLE_LABEL: Record<UserRole, string> = {
  ap_clerk: "AP Clerk",
  finance_manager: "Finance Manager",
  controller_admin: "Admin",
  auditor: "Auditor",
  approver: "Operations Manager",
  employee: "Employee",
};

/** Clerks and the Finance Manager act on payments; the Admin only releases (and clears fraud holds). */
/** The role name for one person: the CFO is told apart from the Controller (Admin) by having no manager. */
export function roleLabelOf(user: DirectoryUser): string {
  return isCfo(user) ? "CFO" : ROLE_LABEL[user.role];
}

export function canAct(role: DashboardRole): boolean {
  return role === "clerk" || role === "finance_manager";
}

export type PageKey = "overview" | "to-schedule" | "to-release" | "needs-attention" | "duplicates";

export type PaymentsPage = {
  key: PageKey;
  href: string;
  label: string;
  roles: DashboardRole[];
  /** Who the page is for, in words, for the "not for your role" message. */
  forWhom: string;
};

export const PAGES: PaymentsPage[] = [
  { key: "overview", href: "/payments", label: "Overview", roles: ["clerk", "finance_manager"], forWhom: "AP Clerks and the Finance Manager" },
  { key: "to-schedule", href: "/payments/to-schedule", label: "To schedule", roles: ["clerk"], forWhom: "AP Clerks (they prepare payments)" },
  { key: "to-release", href: "/payments/to-release", label: "To release", roles: ["finance_manager", "controller"], forWhom: "the Finance Manager (up to $100,000 CAD), the Admin and the CFO (any amount)" },
  { key: "needs-attention", href: "/payments/needs-attention", label: "Needs attention", roles: ["clerk", "finance_manager"], forWhom: "AP Clerks and the Finance Manager" },
  // Feature 5 (Arpan): possible duplicates and card-paid bills; the server re-checks invoice.review / flag.override.
  { key: "duplicates", href: "/payments/duplicates", label: "Duplicates", roles: ["clerk", "finance_manager", "controller"], forWhom: "the people who do the checks" },
];

export function pagesFor(role: DashboardRole): PaymentsPage[] {
  return PAGES.filter((p) => p.roles.includes(role));
}

export function canSeePage(role: DashboardRole, key: PageKey): boolean {
  return pagesFor(role).some((p) => p.key === key);
}

export function pageByKey(key: PageKey): PaymentsPage {
  return PAGES.find((p) => p.key === key)!;
}

/** What each role can do here, in plain words, shown under the sidebar. */
export const ROLE_ABILITIES: Record<DashboardRole, string[]> = {
  clerk: ["Schedule approved invoices", "Retry failed payments", "Can't release payments"],
  finance_manager: [
    "Release payments up to $100,000 CAD",
    "Not ones you approved, requested or scheduled",
  ],
  controller: [
    "Release payments of any amount (over $100,000 CAD only the Controller or the CFO can)",
    "Review fraud-hold escalations",
    "Not ones you approved, requested or scheduled",
  ],
  auditor: ["See every payment and page", "Can't change anything"],
  viewer: ["See where payments stand", "Can't change anything"],
};
