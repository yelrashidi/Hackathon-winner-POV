"use server";

import { ensureDb } from "@/server/demo/database";
import { setUserAvailability, updatePolicy } from "@/server/pipeline";
import { asViewer, text, type FormState } from "../_lib/form";
import { parseMoneyToCents } from "../_lib/format";

/** Edit one approval policy: a NEW version (the old one stays, so past approvals still cite it). */
export async function policyAction(_: FormState, form: FormData): Promise<FormState> {
  await ensureDb();
  return asViewer(async ({ actor }) => {
    const amount = text(form, "amount");
    const days = text(form, "days");
    const cents = amount ? parseMoneyToCents(amount) : undefined;
    if (amount && cents === null) return { messages: [`“${amount}” is not an amount.`] };
    const p = await updatePolicy(actor, text(form, "policyId"), {
      active: form.has("activeField") ? form.get("active") === "1" : undefined,
      amountCadCents: cents ?? undefined,
      newVendorDays: days ? Number(days) : undefined,
      note: text(form, "note"),
    });
    return `${p.id} saved as version ${p.version}. New submits route on it; plans already routed keep theirs.`;
  });
}

export async function availabilityAction(_: FormState, form: FormData): Promise<FormState> {
  await ensureDb();
  return asViewer(async ({ actor }) => {
    const status = text(form, "status") === "on_leave" ? "on_leave" : "active";
    const u = await setUserAvailability(actor, text(form, "userId"), { status, delegateId: text(form, "delegateId") || null, note: text(form, "note") });
    return status === "on_leave" ? `${u.fullName} is on leave; their approvals go to the delegate, recorded as "on behalf of".` : `${u.fullName} is back.`;
  });
}
