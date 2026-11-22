"use server";

// Vendor master actions. Bank changes run Katie's two-person rules (payments, on the database);
// onboarding and status go through pipeline/admin.ts. The actor is always the session's.

import { ensureDb } from "@/server/demo/database";
import { createVendor, paymentsDb, setVendorStatus } from "@/server/pipeline";
import { asViewer, text, type FormState } from "../_lib/form";

const reasons = (r: { ok: boolean; reasons?: { message: string }[] }) => (r.reasons ?? []).map((x) => x.message);

export async function requestBankChangeAction(_: FormState, form: FormData): Promise<FormState> {
  await ensureDb();
  return asViewer(async ({ actor }) => {
    const r = await paymentsDb.requestBankChange(actor, { vendorId: text(form, "vendorId"), institution: text(form, "institution"), transit: text(form, "transit"), account: text(form, "account") });
    if (!r.ok) throw Object.assign(new Error(reasons(r).join(" ")), { name: "Refused" });
    return `New details saved as version ${r.value.version} (••••${r.value.last4}). A second person must verify them before anything is paid to it.`;
  }).catch((e: Error) => ({ ok: false, messages: [e.message] }));
}

export async function verifyBankChangeAction(_: FormState, form: FormData): Promise<FormState> {
  await ensureDb();
  return asViewer(async ({ actor }) => {
    const r = await paymentsDb.verifyBankChange(actor, { vendorId: text(form, "vendorId") });
    if (!r.ok) throw Object.assign(new Error(reasons(r).join(" ")), { name: "Refused" });
    return `Verified: payments now go to ••••${r.value.last4}.`;
  }).catch((e: Error) => ({ ok: false, messages: [e.message] }));
}

export async function rejectBankChangeAction(_: FormState, form: FormData): Promise<FormState> {
  await ensureDb();
  return asViewer(async ({ actor }) => {
    const r = await paymentsDb.rejectBankChange(actor, { vendorId: text(form, "vendorId"), reason: text(form, "reason") });
    if (!r.ok) throw Object.assign(new Error(reasons(r).join(" ")), { name: "Refused" });
    return "Bank change rejected. The verified account stays in use.";
  }).catch((e: Error) => ({ ok: false, messages: [e.message] }));
}

export async function vendorStatusAction(_: FormState, form: FormData): Promise<FormState> {
  await ensureDb();
  return asViewer(async ({ actor }) => {
    const status = text(form, "status") as "active" | "on_hold" | "pending_review";
    await setVendorStatus(actor, text(form, "vendorId"), status, text(form, "note"));
    return `Vendor is now ${status.replace("_", " ")}.`;
  });
}

export async function createVendorAction(_: FormState, form: FormData): Promise<FormState> {
  await ensureDb();
  return asViewer(async ({ actor }) => {
    const v = await createVendor(actor, {
      legalName: text(form, "legalName"),
      category: text(form, "category"),
      provinceOrState: text(form, "province") || null,
      gstHstNumber: text(form, "gst") || null,
      apContactEmail: text(form, "email") || null,
      paymentTermsDays: Number(text(form, "terms")) || 30,
      requiresPo: text(form, "requiresPo") === "1",
    });
    return `${v.legalName} added as ${v.id}, pending review. Someone else approves it before it can be paid.`;
  });
}
