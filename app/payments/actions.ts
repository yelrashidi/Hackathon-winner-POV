"use server";

// Every payment button (dashboard pages and the simulated-bank console) calls one of these.
// The acting person ALWAYS comes from the server session (getCurrentUser), never from the form:
// a form field saying "I am the Controller" is ignored. The payments service then runs the rules.

import { refresh } from "next/cache";
import type { FailureCode } from "@/contracts/payment";
import {
  cancelPayment,
  clearFlag,
  rejectBankChange,
  releasePayment,
  requestBankChange,
  schedulePayment,
  simulateSettlement,
  verifyBankChange,
  type ActionResult,
} from "@/server/features/payments";
import { getCurrentUser } from "@/server/session/current-user";

export type FormState = { ok: boolean; messages: string[] } | null;

async function actorId(): Promise<string | null> {
  return (await getCurrentUser())?.id ?? null;
}

async function toState(pending: Promise<ActionResult<unknown>>, done: string): Promise<FormState> {
  const result = await pending;
  refresh();
  if (result.ok) return { ok: true, messages: [done, ...result.warnings] };
  return { ok: false, messages: result.reasons.map((r) => r.message) };
}

const text = (form: FormData, key: string) => String(form.get(key) ?? "");

/** Schedule an approved invoice, retry after a failed attempt, or schedule again after a cancelled one (a new attempt). */
export async function scheduleAction(_: FormState, form: FormData): Promise<FormState> {
  // Only picks the confirmation text; the rules decide whether a new attempt is allowed.
  const retry = text(form, "retry");
  return toState(
    schedulePayment(await actorId(), { invoiceId: text(form, "invoiceId"), payDate: text(form, "payDate") || undefined }),
    retry === "again" ? "Payment scheduled again (new attempt)" : retry === "1" ? "Retry scheduled as a new attempt." : "Payment scheduled.",
  );
}

export async function releaseAction(_: FormState, form: FormData): Promise<FormState> {
  return toState(releasePayment(await actorId(), { paymentId: text(form, "paymentId") }), "Released to the bank.");
}

export async function cancelAction(_: FormState, form: FormData): Promise<FormState> {
  return toState(cancelPayment(await actorId(), { paymentId: text(form, "paymentId"), reason: text(form, "reason") }), "Payment cancelled.");
}

export async function settleAction(_: FormState, form: FormData): Promise<FormState> {
  const outcome = text(form, "outcome") as "SETTLED" | FailureCode;
  return toState(
    simulateSettlement(await actorId(), { paymentId: text(form, "paymentId"), outcome }),
    outcome === "SETTLED" ? "Bank says: settled." : `Bank says: failed (${outcome}).`,
  );
}

export async function clearFlagAction(_: FormState, form: FormData): Promise<FormState> {
  return toState(clearFlag(await actorId(), { flagId: text(form, "flagId"), note: text(form, "note") }), "Flag cleared.");
}

export async function requestBankAction(_: FormState, form: FormData): Promise<FormState> {
  return toState(
    requestBankChange(await actorId(), {
      vendorId: text(form, "vendorId"),
      institution: text(form, "institution"),
      transit: text(form, "transit"),
      account: text(form, "account"),
    }),
    "New bank details saved. A second person must verify them.",
  );
}

export async function verifyBankAction(_: FormState, form: FormData): Promise<FormState> {
  return toState(verifyBankChange(await actorId(), { vendorId: text(form, "vendorId") }), "Bank details verified.");
}

export async function rejectBankAction(_: FormState, form: FormData): Promise<FormState> {
  return toState(rejectBankChange(await actorId(), { vendorId: text(form, "vendorId"), reason: text(form, "reason") }), "Bank change rejected.");
}
