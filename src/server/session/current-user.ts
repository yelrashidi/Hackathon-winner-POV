// TEMP: demo sign-in. The "Viewing as" switcher stores only a user id in a cookie; the person and
// their role are always looked up HERE, on the server, from the users table. No password, because
// this is a demo — replace with real auth when the team builds it. Every page, server action and
// service call takes the actor from getActor(), never from the request.

import { cookies } from "next/headers";
import { connection } from "next/server";
import { cache } from "react";
import type { Actor } from "@/contracts/actor";
import { ensureDb } from "@/server/demo/database";
import { demoRoster } from "./roster";
import { appRoleOf, type AppRole } from "./roles";
import type { DirectoryUser } from "./users";

export const VIEWING_AS_COOKIE = "hl_viewing_as";

/** A user the switcher may pick: one of the demo cast (one person per role, see roster.ts). */
export async function selectableUser(userId: string): Promise<DirectoryUser | null> {
  if (!userId) return null;
  await connection(); // per request: the database is never read while prerendering
  const db = await ensureDb();
  return (await demoRoster(db)).find((r) => r.user.id === userId)?.user ?? null;
}

/** The demo cast, in role order: Employee, AP Clerk, the department managers, Finance Manager, Admin, CFO, Auditor. */
export async function listSwitchableUsers(): Promise<DirectoryUser[]> {
  await connection();
  const db = await ensureDb();
  return (await demoRoster(db)).map((r) => r.user);
}

/** The person the app is being used as, or null when nobody has been picked. */
export const getCurrentUser = cache(async (): Promise<DirectoryUser | null> => {
  const userId = (await cookies()).get(VIEWING_AS_COOKIE)?.value;
  if (!userId) {
    await connection();
    await ensureDb();
    return null;
  }
  return selectableUser(userId);
});

export interface Viewer {
  user: DirectoryUser;
  role: AppRole;
  actor: Actor;
}

/** The signed-in person as the services want them: the actor passed to authorize(), fire() and audit. */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const user = await getCurrentUser();
  const role = appRoleOf(user);
  if (!user || !role) return null;
  return { user, role, actor: { userId: user.id, role: user.role, onBehalfOf: null } };
});
