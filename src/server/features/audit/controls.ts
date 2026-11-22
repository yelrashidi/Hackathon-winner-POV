import type { AuditInvoiceDetail, ControlCheck } from "@/contracts/audit-view";

/**
 * Control tests an auditor would otherwise do by hand, recomputed from the stored records every
 * time the page opens (never stored, so they cannot drift). Pure: takes the assembled detail.
 * They REPORT; enforcement lives in authorize() / checkDecision() / the DB constraints. A `fail`
 * here on a historical invoice is a finding about the old process, not a bug in ours.
 */
export function controlChecks(d: Omit<AuditInvoiceDetail, "controls" | "timeline">): ControlCheck[] {
  const out: ControlCheck[] = [];
  const add = (id: string, label: string, result: ControlCheck["result"], detail: string) => out.push({ id, label, result, detail });

  const signed = d.approvals.flatMap((p) => p.steps.filter((s) => s.decision === "approved"));
  const signers = new Set(signed.flatMap((s) => [s.actedBy?.userId, s.onBehalfOf?.userId]).filter((x): x is string => !!x));
  const requester = d.invoice.requester?.userId ?? null;
  const reachedApproval = !["Received", "ManualEntry", "InReview", "OnHold"].includes(d.invoice.status) || signed.length > 0;

  // 1. No approving your own request.
  if (!signed.length) add("APPROVER_NOT_REQUESTER", "No one approved their own invoice", "not_applicable", "No approvals recorded.");
  else if (requester && signers.has(requester)) add("APPROVER_NOT_REQUESTER", "No one approved their own invoice", "fail", `The requester (${d.invoice.requester!.name}) signed an approval step.`);
  else add("APPROVER_NOT_REQUESTER", "No one approved their own invoice", "pass", `${signed.length} approval(s), none by the requester.`);

  // 2. Approval authority covered the amount.
  const amount = Math.abs(d.invoice.totalCadCents ?? d.invoice.totalCents ?? 0);
  const limits = signed.map((s) => (s.actedAs as { approvalLimitCents?: number } | null)?.approvalLimitCents).filter((x): x is number => typeof x === "number");
  if (!signed.length || !limits.length) add("APPROVAL_WITHIN_LIMIT", "An approver's limit covered the amount", "not_applicable", "No approver limits recorded.");
  else if (Math.max(...limits) >= amount) add("APPROVAL_WITHIN_LIMIT", "An approver's limit covered the amount", "pass", `Highest approver limit ${(Math.max(...limits) / 100).toFixed(2)} CAD ≥ ${(amount / 100).toFixed(2)} CAD.`);
  else add("APPROVAL_WITHIN_LIMIT", "An approver's limit covered the amount", "fail", `Highest approver limit ${(Math.max(...limits) / 100).toFixed(2)} CAD < ${(amount / 100).toFixed(2)} CAD.`);

  const released = d.payments.filter((p) => p.releasedBy);
  // 3. Whoever approved cannot release (P11).
  if (!released.length) add("RELEASER_DID_NOT_APPROVE", "The person who released payment did not approve it", "not_applicable", "No payment released.");
  else {
    const bad = released.filter((p) => signers.has(p.releasedBy!.userId));
    add(
      "RELEASER_DID_NOT_APPROVE",
      "The person who released payment did not approve it",
      bad.length ? "fail" : "pass",
      bad.length ? `${bad.map((p) => `${p.releasedBy!.name} released ${p.paymentId}`).join("; ")} after approving the invoice.` : `${released.length} release(s) by people independent of the approvals.`,
    );
  }

  // 4. Preparer ≠ releaser.
  if (!released.length) add("PREPARER_NOT_RELEASER", "Payment prepared and released by different people", "not_applicable", "No payment released.");
  else {
    const bad = released.filter((p) => p.preparedBy && p.preparedBy.userId === p.releasedBy!.userId);
    add("PREPARER_NOT_RELEASER", "Payment prepared and released by different people", bad.length ? "fail" : "pass", bad.length ? `${bad.map((p) => p.paymentId).join(", ")} prepared and released by the same person.` : "Two people on every payment.");
  }

  // 5. EFT only to a verified account.
  const eft = d.payments.filter((p) => p.method === "EFT");
  if (!eft.length) add("PAID_TO_VERIFIED_ACCOUNT", "EFT paid only to a verified bank account", "not_applicable", "No EFT payments.");
  else {
    // `superseded` / `closed` = was the verified account, later replaced or closed: verified when used.
    const bad = eft.filter((p) => !p.bankAccount || !["verified", "superseded", "closed"].includes(p.bankAccount.status));
    add(
      "PAID_TO_VERIFIED_ACCOUNT",
      "EFT paid only to a verified bank account",
      bad.length ? "fail" : "pass",
      bad.length
        ? bad.map((p) => (p.bankAccount ? `${p.paymentId} went to account ••${p.bankAccount.last4} (version ${p.bankAccount.version}, ${p.bankAccount.status})` : `${p.paymentId} has no bank account on record`)).join("; ")
        : `${eft.length} EFT payment(s) to verified accounts.`,
    );
  }

  // 6. Nothing blocking was left open past review.
  const openBlocking = d.flags.filter((f) => f.status === "open" && f.severity === "block");
  if (!reachedApproval) add("NO_OPEN_BLOCKING_FLAGS", "No blocking flag left open after review", "not_applicable", "Invoice is still in review.");
  else add("NO_OPEN_BLOCKING_FLAGS", "No blocking flag left open after review", openBlocking.length ? "fail" : "pass", openBlocking.length ? `Open: ${openBlocking.map((f) => f.code).join(", ")}.` : "All blocking flags were resolved or overridden with a note.");

  // 7. Paid no more than the invoice.
  const paid = d.payments.filter((p) => ["released", "settled"].includes(p.status)).reduce((n, p) => n + p.amountCents, 0);
  if (!d.payments.length || d.invoice.totalCents === null) add("PAID_NOT_MORE_THAN_INVOICED", "Not paid more than the invoice total", "not_applicable", "No payments.");
  else add("PAID_NOT_MORE_THAN_INVOICED", "Not paid more than the invoice total", paid > Math.abs(d.invoice.totalCents) ? "fail" : "pass", `Paid ${(paid / 100).toFixed(2)} of ${(Math.abs(d.invoice.totalCents) / 100).toFixed(2)} ${d.invoice.currency ?? ""}.`.trim());

  return out;
}
