import "server-only";

// TEMP: demo sign-in. The "Viewing as" switcher stores only a user id in a cookie; the role is
// always looked up here, on the server, from the employee record. No password, because this is a
// demo — replace with real auth when the team builds it. The payment session reads the signed-in
// person through getCurrentUser() as well, so both sides agree on who is acting.

import { cookies } from "next/headers";
import { cache } from "react";
import { findUser, type DirectoryUser } from "./users";

export const VIEWING_AS_COOKIE = "hl_viewing_as";

/** The person the app is being used as, or null when nobody has been picked (view only). */
export const getCurrentUser = cache(async (): Promise<DirectoryUser | null> => {
  const userId = (await cookies()).get(VIEWING_AS_COOKIE)?.value;
  if (!userId) return null;
  return selectableUser(userId);
});

/** A user the switcher may pick: exists in the directory and isn't terminated. */
export function selectableUser(userId: string): DirectoryUser | null {
  const user = findUser(userId);
  if (!user || user.status === "terminated") return null;
  return user;
}
