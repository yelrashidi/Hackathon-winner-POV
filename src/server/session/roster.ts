import { asc, eq } from "drizzle-orm";
import { departments, users } from "@/server/db/schema";
import type { Executor } from "@/server/db/client";
import { isCfo, type AppRole } from "./roles";
import type { DirectoryUser, UserRole } from "./users";

/**
 * The demo cast: ONE person per role, seven roles (team plan, 2026-11-21 — a 2–3 minute demo; the
 * CFO added 2026-11-25 so a bill the Controller approved can still be released, P10/P11).
 * They are the only people who can sign in. Everyone else stays in the database (history, the
 * requesters the Checks screen offers, approval routing, the audit trail).
 *
 *   Employee            the first active employee who reports to the cast's Operations Manager
 *                       (so the bills the clerk records them on route to that manager)
 *   AP Clerk            first active ap_clerk
 *   Operations Manager  the manager of the Operations department (falls back to the first approver)
 *   Finance Manager     first active finance_manager
 *   Admin               the Controller: the controller_admin who reports to someone (not the CFO)
 *   CFO                 the controller_admin with no manager (the top of the org chart, as approvals'
 *                       candidatesFor("cfo") picks); never the same person as the Admin
 *   Auditor             first active auditor
 */

type Row = typeof users.$inferSelect;

const toUser = (u: Row): DirectoryUser => ({
  id: u.id,
  fullName: u.fullName,
  title: u.title ?? "",
  role: u.role as UserRole,
  departmentId: u.departmentId ?? "",
  managerId: u.managerId,
  approvalLimitCents: u.approvalLimitCents,
  status: u.status,
  statusSince: u.statusSince,
  delegateId: u.delegateId,
});

export async function demoRoster(db: Executor): Promise<{ role: AppRole; user: DirectoryUser }[]> {
  const [all, depts] = await Promise.all([db.select().from(users).where(eq(users.status, "active")).orderBy(asc(users.id)), db.select().from(departments)]);
  const firstOf = (role: string, pred: (u: Row) => boolean = () => true) => all.find((u) => u.role === role && pred(u));
  const opsManagerId = depts.find((d) => d.name.toLowerCase() === "operations")?.managerId;
  const manager = firstOf("approver", (u) => u.id === opsManagerId) ?? firstOf("approver");
  const picks: [AppRole, Row | undefined][] = [
    ["employee", manager ? firstOf("employee", (u) => u.managerId === manager.id) : undefined],
    ["clerk", firstOf("ap_clerk")],
    ["manager", manager],
    ["finance", firstOf("finance_manager")],
    ["admin", firstOf("controller_admin", (u) => !isCfo(u))],
    ["cfo", firstOf("controller_admin", (u) => isCfo(u))],
    ["auditor", firstOf("auditor")],
  ];
  return picks.filter((p): p is [AppRole, Row] => p[1] !== undefined).map(([role, u]) => ({ role, user: toUser(u) }));
}
