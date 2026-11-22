"use server";

// TEMP: demo sign-in action used by the "Viewing as" switcher. See current-user.ts.

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { selectableUser, VIEWING_AS_COOKIE } from "./current-user";

/** Switch the person the app is used as. An unknown, terminated or non-dashboard id signs you out. */
export async function switchViewingAs(formData: FormData): Promise<void> {
  const store = await cookies();
  const user = await selectableUser(String(formData.get("userId") ?? ""));
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

/** Sign in as someone and go to their home screen (the home page's role cards). */
export async function signInAs(formData: FormData): Promise<void> {
  await switchViewingAs(formData);
  redirect("/");
}
