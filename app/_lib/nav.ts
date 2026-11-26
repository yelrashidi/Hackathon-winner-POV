// Which screens each role sees. ONE list drives the sidebar and the check at the top of every page,
// so a hidden link and a blocked page never disagree. The services behind each page run authorize()
// again — typing a URL as the wrong role gets "not for your role", and calling an action gets a 403.

import type { AppRole } from "@/server/session/roles";

export type SectionKey =
  | "home"
  | "inbox"
  | "checks"
  | "upload"
  | "duplicates"
  | "approvals"
  | "payments"
  | "to-schedule"
  | "to-release"
  | "needs-attention"
  | "vendors"
  | "invoices"
  | "audit"
  | "journal"
  | "admin";

export type NavGroup = "Work" | "Payments" | "Records" | "Admin";

export interface Section {
  key: SectionKey;
  href: string;
  label: string;
  group: NavGroup | null;
  roles: AppRole[];
  /** Who it is for, in words, for the "not for your role" page. */
  forWhom: string;
  /** A different label for some roles (the employee's "My bills"). */
  labelFor?: Partial<Record<AppRole, string>>;
}

/** The Controller (Admin) and the CFO hold the same data role (controller_admin), so they get the same screens. */
const CONTROLLERS: AppRole[] = ["admin", "cfo"];
const REVIEWERS: AppRole[] = ["clerk", "manager", "finance", ...CONTROLLERS];

export const SECTIONS: Section[] = [
  { key: "home", href: "/", label: "Home", group: null, roles: ["employee", "clerk", "manager", "finance", ...CONTROLLERS, "auditor"], forWhom: "everyone" },
  { key: "inbox", href: "/inbox", label: "Inbox", group: "Work", roles: REVIEWERS, forWhom: "AP Clerks, managers, the Finance Manager, the Admin and the CFO" },
  { key: "checks", href: "/checks", label: "Checks", group: "Work", roles: REVIEWERS, forWhom: "AP Clerks, managers, the Finance Manager, the Admin and the CFO" },
  {
    key: "upload",
    href: "/checks/upload",
    label: "Upload invoices",
    group: "Work",
    roles: ["employee", ...REVIEWERS],
    forWhom: "employees (a bill they received), AP Clerks, managers, the Finance Manager, the Admin and the CFO",
    labelFor: { employee: "Upload a bill" },
  },
  { key: "duplicates", href: "/payments/duplicates", label: "Duplicates", group: "Work", roles: ["clerk", "finance", ...CONTROLLERS], forWhom: "AP Clerks, the Finance Manager, the Admin and the CFO" },
  { key: "approvals", href: "/approvals", label: "Approvals", group: "Work", roles: ["manager", "finance", ...CONTROLLERS], forWhom: "managers, the Finance Manager, the Admin and the CFO" },
  { key: "payments", href: "/payments", label: "Overview", group: "Payments", roles: ["clerk", "finance"], forWhom: "AP Clerks and the Finance Manager" },
  { key: "to-schedule", href: "/payments/to-schedule", label: "To schedule", group: "Payments", roles: ["clerk"], forWhom: "AP Clerks (they prepare payments)" },
  {
    key: "to-release",
    href: "/payments/to-release",
    label: "To release",
    group: "Payments",
    roles: ["finance", ...CONTROLLERS],
    forWhom: "the Finance Manager (up to $100,000 CAD), the Admin and the CFO (any amount)",
  },
  { key: "needs-attention", href: "/payments/needs-attention", label: "Needs attention", group: "Payments", roles: ["clerk", "finance"], forWhom: "AP Clerks and the Finance Manager" },
  { key: "vendors", href: "/vendors", label: "Vendors", group: "Records", roles: ["clerk", "finance", ...CONTROLLERS, "auditor"], forWhom: "AP Clerks, the Finance Manager, the Admin, the CFO and the Auditor (read-only)" },
  {
    key: "invoices",
    href: "/invoices",
    label: "Invoices",
    group: "Records",
    roles: ["employee", "clerk", "manager", "finance", ...CONTROLLERS, "auditor"],
    forWhom: "everyone — each person sees the invoices their role allows (managers: their department; employees: the bills they requested)",
    labelFor: { employee: "My bills" },
  },
  { key: "audit", href: "/audit", label: "Audit trail", group: "Records", roles: [...CONTROLLERS, "auditor"], forWhom: "the Auditor, the Admin and the CFO" },
  { key: "journal", href: "/journal", label: "Journal export", group: "Records", roles: ["finance", ...CONTROLLERS], forWhom: "the Finance Manager, the Admin and the CFO (they own the books)" },
  { key: "admin", href: "/admin", label: "People & policies", group: "Admin", roles: CONTROLLERS, forWhom: "the Admin and the CFO" },
];

export function section(key: SectionKey): Section {
  return SECTIONS.find((s) => s.key === key)!;
}

export function canSee(role: AppRole | null, key: SectionKey): boolean {
  return role !== null && section(key).roles.includes(role);
}

export function sectionsFor(role: AppRole | null): Section[] {
  return role ? SECTIONS.filter((s) => s.roles.includes(role)) : [];
}

export function labelOf(s: Section, role: AppRole | null): string {
  return (role && s.labelFor?.[role]) || s.label;
}
