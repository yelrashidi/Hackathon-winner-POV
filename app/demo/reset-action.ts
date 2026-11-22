"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ensureDb } from "@/server/demo/database";
import { demoResetMode, resetDemoData } from "@/server/demo/reset";
import { getViewer } from "@/server/session/current-user";

export type ResetState = { ok: boolean; message: string } | null;

/** The "Reset demo data" button. Admin only, checked here on the server (not just by hiding the button). */
export async function resetDemoAction(): Promise<ResetState> {
  await ensureDb();
  const viewer = await getViewer();
  if (viewer?.role !== "admin") return { ok: false, message: "Only the Admin can reset the demo (sign in as Marcus Webb)." };
  if (!demoResetMode()) return { ok: false, message: "Reset is not available on this database." };
  console.log(`[demo] data reset by ${viewer.user.id} (${viewer.user.fullName}) at ${new Date().toISOString()}`);
  try {
    await resetDemoData();
  } catch (err) {
    console.error("[demo] reset failed", err);
    return { ok: false, message: "Reset failed — nothing was changed. See the server log." };
  }
  revalidatePath("/", "layout");
  redirect("/");
}
