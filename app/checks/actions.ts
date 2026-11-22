"use server";

// Every button on the Checks screens. The acting person ALWAYS comes from the server session
// (asViewer), never from the form; each call goes through the pipeline's own authorize →
// transaction → audit → fire(). A refusal comes back as the service's reason, shown under the button.

import { redirect } from "next/navigation";
import { ensureDb } from "@/server/demo/database";
import { overrideFlag, resolveFlag } from "@/server/features/validation";
import { acceptConfidentLines, codeInvoiceLine, editInvoice, enterInvoiceFields, releaseHold, submitForApproval, type InvoicePatch, type ManualFields } from "@/server/pipeline";
import { asViewer, text, type FormState } from "../_lib/form";
import { parseMoneyToCents } from "../_lib/format";

const orNull = (v: string) => (v === "" ? null : v);

/** Correct header fields in review (who asked for it, department, PO, dates, amounts). Only what changed is sent. */
export async function editFieldsAction(_: FormState, form: FormData): Promise<FormState> {
  await ensureDb();
  return asViewer(async ({ actor }) => {
    const invoiceId = text(form, "invoiceId");
    const patch: InvoicePatch = {};
    const was = (k: string) => text(form, `was_${k}`);
    for (const k of ["requesterId", "departmentId", "poId", "shipToProvince", "invoiceNumber", "invoiceDate", "dueDate", "currency"] as const) {
      if (form.has(k) && text(form, k) !== was(k)) patch[k] = orNull(text(form, k));
    }
    for (const k of ["subtotalCents", "totalCents"] as const) {
      if (!form.has(k) || text(form, k) === was(k)) continue;
      const raw = text(form, k);
      const cents = raw === "" ? null : parseMoneyToCents(raw);
      if (raw !== "" && cents === null) return { messages: [`“${raw}” is not an amount.`], data: { error: "1" } };
      patch[k] = cents;
    }
    const result = await editInvoice(actor, invoiceId, patch, { reason: text(form, "reason") || undefined });
    return [`Saved. Validation and coding ran again: ${result.result.flags.length} flag(s) now.`];
  });
}

/** Accept a line's suggestion as is, or change the account / department (a note is required when overriding a confident suggestion). */
export async function codeLineAction(_: FormState, form: FormData): Promise<FormState> {
  await ensureDb();
  return asViewer(async ({ actor }) => {
    const line = await codeInvoiceLine(actor, text(form, "invoiceId"), Number(text(form, "lineNo")), {
      glAccount: text(form, "glAccount"),
      departmentId: text(form, "departmentId"),
      note: text(form, "note") || undefined,
    });
    return `Line ${line.lineNo} ${line.source === "changed" ? "changed" : "accepted"}: ${line.glAccount} · ${line.departmentId}.`;
  });
}

/** Confirm every line coding is confident about in one go (bulk accept). */
export async function acceptConfidentAction(_: FormState, form: FormData): Promise<FormState> {
  await ensureDb();
  return asViewer(async ({ actor }) => {
    const minimum = text(form, "minimum") === "medium" ? "medium" : "high";
    const accepted = await acceptConfidentLines(actor, text(form, "invoiceId"), { minimum });
    return accepted.length ? `Accepted ${accepted.length} line(s).` : `No ${minimum}-confidence suggestions left to accept.`;
  });
}

/** Close a flag: resolved (the cause was fixed) or overridden (accepted as is). Both need a note. */
export async function flagAction(_: FormState, form: FormData): Promise<FormState> {
  await ensureDb();
  return asViewer(async ({ actor }) => {
    const id = Number(text(form, "flagId"));
    const note = text(form, "note");
    if (text(form, "decision") === "override") {
      await overrideFlag(actor, id, note);
      return "Flag overridden. Approvers will be asked to acknowledge it.";
    }
    await resolveFlag(actor, id, note);
    return "Flag resolved.";
  });
}

/** Send it to approval: approvals routes it (or holds it) and says who signs. */
export async function submitAction(_: FormState, form: FormData): Promise<FormState> {
  await ensureDb();
  return asViewer(async ({ actor }) => {
    const plan = await submitForApproval(actor, text(form, "invoiceId"));
    if (plan.outcome === "hold") return [`Put on hold: ${plan.holdReasons.map((r) => r.message).join(" · ")}`];
    return [`Sent to approval: ${plan.steps.length} step(s). It now waits for step 1.`];
  });
}

/** An approval hold was dealt with: back to review, with a note saying how. */
export async function releaseHoldAction(_: FormState, form: FormData): Promise<FormState> {
  await ensureDb();
  return asViewer(async ({ actor }) => {
    await releaseHold(actor, text(form, "invoiceId"), text(form, "note"));
    return "Back in review. Fix what the hold asked for, then submit again.";
  });
}

export type ManualEntryResult = { ok: true; message: string } | { ok: false; errors: string[] };

/** Type in a bill extraction couldn't read (ManualEntry → InReview). */
export async function manualEntryAction(invoiceId: string, fields: ManualFields): Promise<ManualEntryResult> {
  await ensureDb();
  const state = await asViewer(async ({ actor }) => {
    const r = await enterInvoiceFields(actor, invoiceId, fields);
    return `Saved. Validation and coding ran: ${r.result.flags.length} flag(s), ${r.coding.lines.length} line(s) coded.`;
  });
  if (!state?.ok) return { ok: false, errors: state?.messages ?? ["Something went wrong."] };
  redirect(`/checks/${invoiceId}`);
}
