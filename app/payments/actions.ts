"use server";

// Every payment button (dashboard pages and the simulated bank on /demo) calls one of these.
// The acting person ALWAYS comes from the server session (getViewer), never from the form: a form
// field saying "I am the Controller" is ignored. Katie's payments rules then decide, on the database
// (src/server/pipeline/payments.ts): each action is one transaction with its audit rows and fire().

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import type { FailureCode } from "@/contracts/payment";
import { ensureDb, resetDemoDb, usingDemoDb } from "@/server/demo/database";
import type { ActionResult } from "@/server/features/payments";
import { paymentsDb } from "@/server/pipeline";
import { getViewer } from "@/server/session/current-user";
import type { FormState } from "../_lib/form";

export type { FormState } from "../_lib/form";

async function run(act: (actor: NonNullable<Awaited<ReturnType<typeof getViewer>>>["actor"]) => Promise<ActionResult<unknown>>, done: string): Promise<FormState> {
  await ensureDb();
  const viewer = await getViewer();
  if (!viewer) return { ok: false, messages: ["Pick who you are in the top-right first."] };
  const result = await act(viewer.actor);
  refresh();
  if (result.ok) return { ok: true, messages: [done, ...result.warnings] };
  return { ok: false, messages: result.reasons.map((r) => r.message) };
}

const text = (form: FormData, key: string) => String(form.get(key) ?? "");

/** Schedule an approved invoice, retry after a failed attempt, or schedule again after a cancelled one (a new attempt). */
export async function scheduleAction(_: FormState, form: FormData): Promise<FormState> {
  const retry = text(form, "retry");
  return run(
    (actor) => paymentsDb.schedule(actor, { invoiceId: text(form, "invoiceId"), payDate: text(form, "payDate") || undefined }),
    retry === "again" ? "Payment scheduled again (new attempt)" : retry === "1" ? "Retry scheduled as a new attempt." : "Payment scheduled.",
  );
}

export async function releaseAction(_: FormState, form: FormData): Promise<FormState> {
  return run((actor) => paymentsDb.release(actor, { paymentId: text(form, "paymentId") }), "Released to the bank.");
}

export async function cancelAction(_: FormState, form: FormData): Promise<FormState> {
  return run((actor) => paymentsDb.cancel(actor, { paymentId: text(form, "paymentId"), reason: text(form, "reason") }), "Payment cancelled.");
}

export async function settleAction(_: FormState, form: FormData): Promise<FormState> {
  const outcome = text(form, "outcome") as "SETTLED" | FailureCode;
  return run((actor) => paymentsDb.settle(actor, { paymentId: text(form, "paymentId"), outcome }), outcome === "SETTLED" ? "Bank says: settled." : `Bank says: failed (${outcome}).`);
}

export async function clearFlagAction(_: FormState, form: FormData): Promise<FormState> {
  return run((actor) => paymentsDb.clearFlag(actor, { flagId: text(form, "flagId"), note: text(form, "note") }), "Flag cleared.");
}

export async function requestBankAction(_: FormState, form: FormData): Promise<FormState> {
  return run(
    (actor) => paymentsDb.requestBankChange(actor, { vendorId: text(form, "vendorId"), institution: text(form, "institution"), transit: text(form, "transit"), account: text(form, "account") }),
    "New bank details saved. A second person must verify them.",
  );
}

export async function verifyBankAction(_: FormState, form: FormData): Promise<FormState> {
  return run((actor) => paymentsDb.verifyBankChange(actor, { vendorId: text(form, "vendorId") }), "Bank details verified.");
}

export async function rejectBankAction(_: FormState, form: FormData): Promise<FormState> {
  return run((actor) => paymentsDb.rejectBankChange(actor, { vendorId: text(form, "vendorId"), reason: text(form, "reason") }), "Bank change rejected.");
}

/** Demo only: what an AP Clerk would do on a few clean bills (as that clerk, audited), so approvers have a queue. */
export async function sendToApprovalDemo(): Promise<FormState> {
  await ensureDb();
  const viewer = await getViewer();
  if (!usingDemoDb() || !viewer || !["clerk", "finance", "admin", "cfo"].includes(viewer.role)) {
    return { ok: false, messages: ["Demo controls are for the demo database, signed in as an AP Clerk, the Finance Manager, the Admin or the CFO."] };
  }
  const { sendCleanBillsToApproval } = await import("@/server/demo/scenario");
  const sent = await sendCleanBillsToApproval(3);
  refresh();
  return sent.length ? { ok: true, messages: [`Sent ${sent.length} bill(s) to approval as the AP Clerk: ${sent.join(", ")}.`] } : { ok: false, messages: ["No clean bills left in Checks to send."] };
}

/**
 * Demo only: start again from the dataset (the in-process demo database is rebuilt, its history
 * included). Refused on a real database, and for anyone but the Admin (TODO review finding P1).
 */
export async function resetDemo(): Promise<void> {
  if (!usingDemoDb()) return;
  const viewer = await getViewer();
  if (viewer?.role !== "admin") return;
  console.log(`[demo-db] reset by ${viewer.user.id} (${viewer.user.fullName}) at ${new Date().toISOString()}`);
  await resetDemoDb();
  redirect("/");
}
