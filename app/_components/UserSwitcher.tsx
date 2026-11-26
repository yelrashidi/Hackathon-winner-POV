import { getViewer, listSwitchableUsers } from "@/server/session/current-user";
import { APP_ROLES, appRoleOf, roleInfo } from "@/server/session/roles";
import { UserSwitcherMenu, type SwitcherGroup } from "./UserSwitcherMenu";

/** "Viewing as: name (role)". Picks a person; the role is looked up on the server from their record. */
export async function UserSwitcher() {
  const [viewer, people] = await Promise.all([getViewer(), listSwitchableUsers()]);
  const groups: SwitcherGroup[] = APP_ROLES.map((r) => ({
    label: r.label,
    people: people
      .filter((u) => appRoleOf(u) === r.key)
      .map((u) => ({ id: u.id, fullName: u.fullName, detail: u.status === "on_leave" ? `${u.title} · on leave` : u.title })),
  }));
  return (
    <UserSwitcherMenu
      current={viewer ? { id: viewer.user.id, fullName: viewer.user.fullName, roleLabel: roleInfo(viewer.role).label } : null}
      groups={groups}
    />
  );
}
