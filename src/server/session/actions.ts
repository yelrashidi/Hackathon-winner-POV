"use server";

// TEMP: demo sign-in action used by the "Viewing as" switcher. See current-user.ts.

import { cookies, headers } from "next/headers";
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
    // Secure only when the browser really is on HTTPS (directly, or behind a proxy that says so).
    // Keying it on NODE_ENV broke sign-in on the production build served over plain http
    // (Docker on http://localhost:3000): Safari drops a Secure cookie there, so every page after
    // the first said "not signed in" (BUG-Andrew-09).
    secure: await isHttps(),
    path: "/",
    maxAge: 60 * 60 * 12,
  });
}

async function isHttps(): Promise<boolean> {
  const h = await headers();
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return proto ? proto === "https" : (h.get("origin") ?? "").startsWith("https://");
}

/** Sign in as someone and go to their home screen (the home page's role cards). */
export async function signInAs(formData: FormData): Promise<void> {
  await switchViewingAs(formData);
  redirect("/");
}
