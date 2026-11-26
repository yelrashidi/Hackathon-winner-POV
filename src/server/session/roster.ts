import { asc, ne } from "drizzle-orm";
import { departments, users } from "@/server/db/schema";
import type { Executor } from "@/server/db/client";
import { isCfo, type AppRole } from "./roles";
import type { DirectoryUser, UserRole } from "./users";

/**
 * The demo cast: one person per role, seven roles (team plan, 2026-11-21 — a 2–3 minute demo; the
 * CFO added 2026-11-25 so a bill the Controller approved can still be released, P10/P11), except
 * managers: EVERY department manager signs in (2026-11-25), so each department's bills have their
 * own approver to show.
 * They are the only people who can sign in. Everyone else stays in the database (history, the
 * requesters the Checks screen offers, approval routing, the audit trail).
 *
 *   Employee            the first active employee who reports to the Operations manager
 *                       (so the bills the clerk records them on route to that manager)
 *   AP Clerk            first active ap_clerk
 *   Managers            every department's manager (departments.manager_user_id) who holds the
 *                       approver role, Operations first, then by department id. A manager on leave
 *                       is included (P08): they can sign in and see their work, but the server lets
 *                       only their delegate approve. Terminated people never sign in. A department
 *                       run by the Controller or the CFO keeps them in their own role.
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
  const [people, depts] = await Promise.all([
    db.select().from(users).where(ne(users.status, "terminated")).orderBy(asc(users.id)),
    db.select().from(departments).orderBy(asc(departments.id)),
  ]);
  const all = people.filter((u) => u.status === "active");
  const firstOf = (role: string, pred: (u: Row) => boolean = () => true) => all.find((u) => u.role === role && pred(u));
  const isOps = (d: { name: string }) => d.name.toLowerCase() === "operations";
  // Every department manager who is an approver (active or on leave), Operations first, once each.
  const managers: Row[] = [];
  for (const d of [...depts.filter(isOps), ...depts.filter((d) => !isOps(d))]) {
    const m = people.find((u) => u.id === d.managerId && u.role === "approver");
    if (m && !managers.includes(m)) managers.push(m);
  }
  const opsManager = managers.find((m) => m.id === depts.find(isOps)?.managerId) ?? managers[0];
  const picks: [AppRole, Row | undefined][] = [
    ["employee", opsManager ? firstOf("employee", (u) => u.managerId === opsManager.id) : undefined],
    ["clerk", firstOf("ap_clerk")],
    ...managers.map((m): [AppRole, Row] => ["manager", m]),
    ["finance", firstOf("finance_manager")],
    ["admin", firstOf("controller_admin", (u) => !isCfo(u))],
    ["cfo", firstOf("controller_admin", (u) => isCfo(u))],
    ["auditor", firstOf("auditor")],
  ];
  return picks.filter((p): p is [AppRole, Row] => p[1] !== undefined).map(([role, u]) => ({ role, user: toUser(u) }));
}
