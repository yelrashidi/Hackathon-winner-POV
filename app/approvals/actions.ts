"use server";

// Approve / reject the current step. Who may act is decided by approvals' checkDecision() inside
// decideApproval() (delegation, escalation, separation of duties, acknowledgement of every exception);
// the person comes from the session, never the form.

import { ensureDb } from "@/server/demo/database";
import { decideApproval } from "@/server/pipeline";
import { asViewer, text, type FormState } from "../_lib/form";

export async function decideAction(_: FormState, form: FormData): Promise<FormState> {
  await ensureDb();
  return asViewer(async ({ actor }) => {
    const action = text(form, "decision") === "reject" ? "reject" : "approve";
    const res = await decideApproval(actor, text(form, "invoiceId"), {
      action,
      comment: text(form, "comment") || undefined,
      acknowledgedFlags: form.getAll("ack").map(String),
    });
    if (res.step.decision === "rejected") return "Rejected. It goes back to Checks with your comment.";
    return res.status === "Approved" ? "Approved — that was the last step. It is now ready for payment." : `Approved step ${res.step.seq}. It moves to the next approver.`;
  });
}
