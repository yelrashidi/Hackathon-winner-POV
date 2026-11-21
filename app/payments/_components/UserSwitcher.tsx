import { getCurrentUser } from "@/server/session/current-user";
import { listUsers, type DirectoryUser } from "@/server/session/users";
import { canAct, dashboardRole, ROLE_LABEL } from "../_lib/access";
import { UserSwitcherMenu, type SwitcherGroup } from "./UserSwitcherMenu";

/** "Viewing as: name (role)". Picks a person; the role is looked up on the server. */
export async function UserSwitcher() {
  const user = await getCurrentUser();
  const people = listUsers().filter((u) => u.status !== "terminated");

  const byName = (a: DirectoryUser, b: DirectoryUser) => a.fullName.localeCompare(b.fullName);
  const pick = (roles: DirectoryUser["role"][]) => people.filter((u) => roles.includes(u.role)).sort(byName);
  const toOption = (u: DirectoryUser) => ({
    id: u.id,
    fullName: u.fullName,
    detail: u.status === "on_leave" ? `${u.title} · on leave` : u.title,
  });

  const groups: SwitcherGroup[] = [
    { label: "Controller", people: pick(["controller_admin"]).map(toOption) },
    { label: "Finance Manager", people: pick(["finance_manager"]).map(toOption) },
    { label: "Clerk", people: pick(["ap_clerk"]).map(toOption) },
    {
      label: "Other employee · view only",
      people: pick(["auditor", "approver", "employee"]).map(toOption),
    },
  ];

  return (
    <UserSwitcherMenu
      current={
        user
          ? {
              id: user.id,
              fullName: user.fullName,
              roleLabel: ROLE_LABEL[user.role],
              viewOnly: !canAct(dashboardRole(user)),
            }
          : null
      }
      groups={groups}
    />
  );
}
