"use server";

// Vendor master actions (feature 9, Andrew's service: src/server/features/vendors). Each runs
// authorize() → one transaction → audit, re-checks the vendor's open invoices, and enforces the
// two-person rules (whoever onboarded a vendor or entered bank details cannot approve / verify them).
// The actor is always the session's.

import { ensureDb } from "@/server/demo/database";
import { approveVendor, holdVendor, onboardVendor, rejectBankChange, releaseVendorHold, requestBankChange, VendorError, verifyBankChange } from "@/server/features/vendors";
import { asViewer, text, type FormState } from "../_lib/form";

/** VendorError carries the service's reasons: show them under the button. */
async function vendorAction(fn: Parameters<typeof asViewer>[0]): Promise<FormState> {
  try {
    return await asViewer(fn);
  } catch (err) {
    if (err instanceof VendorError) return { ok: false, messages: err.reasons.map((r) => r.message) };
    throw err;
  }
}

const revalidated = (ids: string[]) => (ids.length ? ` ${ids.length} open invoice(s) re-checked.` : "");

export async function requestBankChangeAction(_: FormState, form: FormData): Promise<FormState> {
  await ensureDb();
  return vendorAction(async ({ actor }) => {
    const r = await requestBankChange(actor, text(form, "vendorId"), { institution: text(form, "institution"), transit: text(form, "transit"), account: text(form, "account") });
    return `New details saved as version ${r.version} (••••${r.last4}). A second person must verify them before anything is paid to it.`;
  });
}

export async function verifyBankChangeAction(_: FormState, form: FormData): Promise<FormState> {
  await ensureDb();
  return vendorAction(async ({ actor }) => {
    const r = await verifyBankChange(actor, text(form, "vendorId"));
    return `Verified: payments now go to ••••${r.last4}.${revalidated(r.revalidatedInvoices)}`;
  });
}

export async function rejectBankChangeAction(_: FormState, form: FormData): Promise<FormState> {
  await ensureDb();
  return vendorAction(async ({ actor }) => {
    await rejectBankChange(actor, text(form, "vendorId"), { reason: text(form, "reason") });
    return "Bank change rejected. The verified account stays in use.";
  });
}

export async function vendorStatusAction(_: FormState, form: FormData): Promise<FormState> {
  await ensureDb();
  return vendorAction(async ({ actor }) => {
    const id = text(form, "vendorId");
    const note = text(form, "note");
    const status = text(form, "status");
    const r =
      status === "on_hold" ? await holdVendor(actor, id, { reason: note })
      : status === "release" ? await releaseVendorHold(actor, id, { reason: note })
      : await approveVendor(actor, id, { note });
    return `Vendor is now ${r.status.replace("_", " ")}.${revalidated(r.revalidatedInvoices)}`;
  });
}

export async function createVendorAction(_: FormState, form: FormData): Promise<FormState> {
  await ensureDb();
  return vendorAction(async ({ actor }) => {
    const r = await onboardVendor(actor, {
      legalName: text(form, "legalName"),
      category: text(form, "category"),
      provinceOrState: text(form, "province") || null,
      gstHstNumber: text(form, "gst") || null,
      apContactEmail: text(form, "email") || null,
      paymentTermsDays: Number(text(form, "terms")) || 30,
      requiresPo: text(form, "requiresPo") === "1",
    });
    return [`Added as ${r.vendorId}, pending review. Someone else approves it before it can be paid.`, ...r.warnings.map((w) => w.message)];
  });
}
