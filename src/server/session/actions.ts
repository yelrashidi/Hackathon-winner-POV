"use server";

// TEMP: demo sign-in action used by the "Viewing as" switcher. See current-user.ts.

import { cookies } from "next/headers";
import { selectableUser, VIEWING_AS_COOKIE } from "./current-user";

/** Switch the person the app is used as. An unknown or terminated id signs you out (view only). */
export async function switchViewingAs(formData: FormData): Promise<void> {
  const store = await cookies();
  const user = selectableUser(String(formData.get("userId") ?? ""));
  if (!user) {
    store.delete(VIEWING_AS_COOKIE);
    return;
  }
  store.set(VIEWING_AS_COOKIE, user.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
}
