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
  /** A different label for some roles (the Admin's narrow release queue). */
  labelFor?: Partial<Record<AppRole, string>>;
}

const REVIEWERS: AppRole[] = ["clerk", "manager", "finance", "admin"];

export const SECTIONS: Section[] = [
  { key: "home", href: "/", label: "Home", group: null, roles: ["clerk", "manager", "finance", "admin", "auditor"], forWhom: "everyone" },
  { key: "inbox", href: "/inbox", label: "Inbox", group: "Work", roles: REVIEWERS, forWhom: "AP Clerks, managers, the Finance Manager and the Admin" },
  { key: "checks", href: "/checks", label: "Checks", group: "Work", roles: REVIEWERS, forWhom: "AP Clerks, managers, the Finance Manager and the Admin" },
  { key: "upload", href: "/checks/upload", label: "Upload invoices", group: "Work", roles: REVIEWERS, forWhom: "AP Clerks, managers, the Finance Manager and the Admin" },
  { key: "duplicates", href: "/payments/duplicates", label: "Duplicates", group: "Work", roles: ["clerk", "finance", "admin"], forWhom: "AP Clerks, the Finance Manager and the Admin" },
  { key: "approvals", href: "/approvals", label: "Approvals", group: "Work", roles: ["manager", "finance", "admin"], forWhom: "managers, the Finance Manager and the Admin" },
  { key: "payments", href: "/payments", label: "Overview", group: "Payments", roles: ["clerk", "finance"], forWhom: "AP Clerks and the Finance Manager" },
  { key: "to-schedule", href: "/payments/to-schedule", label: "To schedule", group: "Payments", roles: ["clerk"], forWhom: "AP Clerks (they prepare payments)" },
  {
    key: "to-release",
    href: "/payments/to-release",
    label: "To release",
    group: "Payments",
    roles: ["finance", "admin"],
    forWhom: "the Finance Manager (and the Admin, for what the Finance Manager can't release)",
    labelFor: { admin: "Admin releases" },
  },
  { key: "needs-attention", href: "/payments/needs-attention", label: "Needs attention", group: "Payments", roles: ["clerk", "finance"], forWhom: "AP Clerks and the Finance Manager" },
  { key: "vendors", href: "/vendors", label: "Vendors", group: "Records", roles: ["clerk", "finance", "admin"], forWhom: "AP Clerks, the Finance Manager and the Admin" },
  { key: "audit", href: "/audit", label: "Audit trail", group: "Records", roles: ["clerk", "manager", "finance", "admin", "auditor"], forWhom: "every role" },
  { key: "journal", href: "/journal", label: "Journal export", group: "Records", roles: ["finance", "admin"], forWhom: "the Finance Manager and the Admin (they own the books)" },
  { key: "admin", href: "/admin", label: "People & policies", group: "Admin", roles: ["admin"], forWhom: "the Admin" },
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
