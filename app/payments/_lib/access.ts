// Which payments pages each person sees, and whether they can act. One list drives both the
// sidebar and the check at the top of every page, so a hidden link and a blocked page never
// disagree. Typing a page's URL still runs the check on the server.

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
  controller_admin: "Controller",
  auditor: "Auditor",
  approver: "Approver",
  employee: "Employee",
};

/** Clerks, Finance Managers and Controllers act on payments; everyone else is view only. */
export function canAct(role: DashboardRole): boolean {
  return role === "clerk" || role === "finance_manager" || role === "controller";
}

export type PageKey = "overview" | "upload" | "to-schedule" | "to-release" | "needs-attention" | "duplicates";

export type PaymentsPage = {
  key: PageKey;
  href: string;
  label: string;
  roles: DashboardRole[];
  /** Who the page is for, in words, for the "not for your role" message. */
  forWhom: string;
};

export const PAGES: PaymentsPage[] = [
  {
    key: "overview",
    href: "/payments",
    label: "Overview",
    roles: ["clerk", "finance_manager", "controller", "auditor", "viewer"],
    forWhom: "everyone",
  },
  {
    key: "upload",
    href: "/payments/upload",
    label: "Upload invoices",
    roles: ["clerk", "controller"],
    forWhom: "AP Clerks and Controllers",
  },
  {
    key: "to-schedule",
    href: "/payments/to-schedule",
    label: "To schedule",
    roles: ["clerk", "controller", "auditor"],
    forWhom: "AP Clerks and Controllers",
  },
  {
    key: "to-release",
    href: "/payments/to-release",
    label: "To release",
    roles: ["finance_manager", "controller", "auditor"],
    forWhom: "Finance Managers and Controllers",
  },
  {
    key: "needs-attention",
    href: "/payments/needs-attention",
    label: "Needs attention",
    roles: ["clerk", "finance_manager", "controller", "auditor"],
    forWhom: "AP Clerks, Finance Managers and Controllers",
  },
  {
    // Feature 5: possible duplicates and card-paid bills. A person decides every one; the server
    // re-checks the role (invoice.review / flag.override) on each action.
    key: "duplicates",
    href: "/payments/duplicates",
    label: "Duplicates",
    roles: ["clerk", "controller", "auditor"],
    forWhom: "AP Clerks and Controllers",
  },
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
  clerk: ["Schedule approved invoices", "Retry failed payments", "Decide possible duplicates", "Can't release payments"],
  finance_manager: [
    "Release payments up to $100,000 CAD",
    "Not ones you approved, requested or scheduled",
  ],
  controller: [
    "Release payments of any amount",
    "Review escalations",
    "Decide possible duplicates",
    "Not ones you approved, requested or scheduled",
  ],
  auditor: ["See every payment and page", "Can't change anything"],
  viewer: ["See where payments stand", "Can't change anything"],
};
