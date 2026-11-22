import { cookies } from "next/headers";
import { usingDemoDb } from "@/server/demo/database";
import { selectableUser, VIEWING_AS_COOKIE } from "@/server/session/current-user";

// Demo only: a link that signs you in as someone and opens a page — /demo/as/U004?next=/checks.
// Handy for a live demo (one click per role) and for screenshots. Same rule as the switcher: only
// the five dashboard roles, and the role still comes from the employee record. Off on a real database.
export async function GET(request: Request, { params }: RouteContext<"/demo/as/[userId]">) {
  if (!usingDemoDb()) return new Response("Not available on a real database.", { status: 404 });
  const { userId } = await params;
  const user = await selectableUser(userId);
  const url = new URL(request.url);
  const next = url.searchParams.get("next") ?? "/";
  const target = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  const store = await cookies();
  if (user) store.set(VIEWING_AS_COOKIE, user.id, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 12 });
  else store.delete(VIEWING_AS_COOKIE);
  return Response.redirect(new URL(target, url.origin), 303);
}
