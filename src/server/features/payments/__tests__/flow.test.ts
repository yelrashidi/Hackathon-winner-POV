import { beforeEach, describe, expect, it } from "vitest";
import { PaymentsView } from "@/contracts/payment";
import {
  cancelPayment,
  clearFlag,
  getPaymentAudit,
  getPaymentDetail,
  listPayments,
  rejectBankChange,
  releasePayment,
  requestBankChange,
  resetState,
  schedulePayment,
  simulateSettlement,
  verifyBankChange,
  type ActionResult,
} from "..";

// End to end on the real dataset (the in-memory store loads the CSVs). People:
// U003 Elise Tremblay (Finance Manager) · U002 Marcus Webb (Controller) · U004 Jordan Okafor and
// U005 Sam Patel (AP clerks) · U006 Hannah Lindqvist (auditor) · U007 Dev Malhotra (approver, D01).

const now = new Date("2026-11-21T15:00:00-05:00");
const opts = { now };

async function ok<T>(p: Promise<ActionResult<T>>): Promise<T> {
  const r = await p;
  if (!r.ok) throw new Error(`Refused: ${r.reasons.map((x) => `${x.code} ${x.message}`).join("; ")}`);
  return r.value;
}
const refusedCodes = async (p: Promise<ActionResult<unknown>>) => {
  const r = await p;
  return r.ok ? [] : r.reasons.map((x) => x.code);
};
const detail = async (invoiceId: string) => (await getPaymentDetail("U003", invoiceId))!;
const current = async (invoiceId: string) => (await detail(invoiceId)).current;

beforeEach(async () => {
  await resetState();
});

describe("payments on the dataset", async () => {
  it("what the dashboard gets matches the contract", async () => {
    const view = await listPayments("U003");
    expect(() => PaymentsView.parse(view)).not.toThrow();
    expect(view.awaitingPayment.map((i) => i.invoiceId)).toEqual(["AP-00425", "AP-00426"]);
    expect(view.payments.length).toBeGreaterThan(5);
  });

  it("happy path: clerk schedules, Finance Manager releases, bank settles, invoice is Paid", async () => {
    const p = await ok(schedulePayment("U004", { invoiceId: "AP-00425" }, opts));
    expect(p.status).toBe("scheduled");
    expect(p.scheduledDate).toBe("2026-11-23"); // due date (a Monday)
    expect(await refusedCodes(releasePayment("U004", { paymentId: p.paymentId }, opts))).toContain("ROLE_CANNOT_RELEASE");
    await ok(releasePayment("U003", { paymentId: p.paymentId }, opts));
    await ok(simulateSettlement("U004", { paymentId: p.paymentId, outcome: "SETTLED" }, opts));
    const row = (await detail("AP-00425"));
    expect(row.current.status).toBe("settled");
    expect(row.invoice.status).toBe("Paid");
  });

  it("the Finance Manager approved AP-00422, so only the Controller can release it (P11)", async () => {
    const pay = (await current("AP-00422"));
    expect(await refusedCodes(releasePayment("U003", { paymentId: pay.paymentId }, opts))).toEqual(["APPROVED_IT"]);
    await ok(releasePayment("U002", { paymentId: pay.paymentId }, opts));
  });

  it("Cascadia Cartage's unverified email bank change blocks release until a second person verifies or rejects it", async () => {
    const p = await ok(schedulePayment("U004", { invoiceId: "AP-00426" }, opts));
    expect(p.bankAccount.last4).toBe("7504"); // the last verified account, not the emailed one
    expect(await refusedCodes(releasePayment("U003", { paymentId: p.paymentId }, opts))).toEqual(["BANK_CHANGE_PENDING"]);
    await ok(rejectBankChange("U003", { vendorId: "V004", reason: "Supplier confirmed by phone they never changed banks" }, opts));
    await ok(releasePayment("U003", { paymentId: p.paymentId }, opts));
  });

  it("demo flow: release → fail (account closed) → retry blocked → new details → verified by someone else → retry → settled", async () => {
    const first = await ok(schedulePayment("U004", { invoiceId: "AP-00425" }, opts));
    await ok(releasePayment("U003", { paymentId: first.paymentId }, opts));
    await ok(simulateSettlement("U004", { paymentId: first.paymentId, outcome: "ACCOUNT_CLOSED" }, opts));

    let row = (await detail("AP-00425"));
    expect(row.invoice.status).toBe("Approved"); // still owed
    expect(row.current.failure?.retryRule).toBe("FIX_BANK_DETAILS");
    expect(row.flags.map((f) => [f.urgency, f.scope])).toEqual([["high", "supplier"]]);

    expect(await refusedCodes(schedulePayment("U004", { invoiceId: "AP-00425" }, opts))).toEqual(["FIX_BANK_DETAILS_FIRST"]);
    await ok(requestBankChange("U004", { vendorId: "V006", institution: "002", transit: "12345", account: "1234567890" }, opts));
    expect(await refusedCodes(verifyBankChange("U004", { vendorId: "V006" }, opts))).toEqual(["ROLE_CANNOT_VERIFY", "ENTERED_IT"]);
    await ok(verifyBankChange("U003", { vendorId: "V006" }, opts));

    row = (await detail("AP-00425"));
    expect(row.flags[0]!.clearedAutomatically).toBe(true); // High cleared by verified details

    const second = await ok(schedulePayment("U005", { invoiceId: "AP-00425" }, opts));
    expect(second.attemptNo).toBe(2);
    expect(second.bankAccount.last4).toBe("7890");
    await ok(releasePayment("U003", { paymentId: second.paymentId }, opts));
    await ok(simulateSettlement("U005", { paymentId: second.paymentId, outcome: "SETTLED" }, opts));

    row = (await detail("AP-00425"));
    expect(row.attempts.map((a) => [a.attemptNo, a.status, a.failure?.code ?? null])).toEqual([
      [1, "failed", "ACCOUNT_CLOSED"],
      [2, "settled", null],
    ]);
    expect(row.invoice.status).toBe("Paid");
  });

  it("a closed account blocks the supplier's other payments to it", async () => {
    // Talentbridge (V048) has two scheduled payments: AP-00419 and AP-00422.
    await ok(releasePayment("U003", { paymentId: (await current("AP-00419")).paymentId }, opts));
    await ok(simulateSettlement("U004", { paymentId: (await current("AP-00419")).paymentId, outcome: "ACCOUNT_CLOSED" }, opts));
    expect(await refusedCodes(releasePayment("U002", { paymentId: (await current("AP-00422")).paymentId }, opts))).toEqual(["BANK_ACCOUNT_CLOSED"]);
    expect((await detail("AP-00422")).flags[0]!.message).toBe("Review: a payment to this supplier failed (Account closed) on 2026-11-21.");
  });

  it("Critical: a fraud hold stops every payment to the supplier until the Controller clears it", async () => {
    // Summit Packaging (V011) has two scheduled payments: AP-00394 and AP-00407.
    const a = (await current("AP-00394"));
    await ok(releasePayment("U003", { paymentId: a.paymentId }, opts));
    await ok(simulateSettlement("U004", { paymentId: a.paymentId, outcome: "FRAUD_HOLD" }, opts));

    const b = (await current("AP-00407"));
    expect(b.status).toBe("on_hold");
    const refused = await releasePayment("U003", { paymentId: b.paymentId }, opts);
    expect(!refused.ok && refused.reasons.map((r) => r.message)).toContain("Stopped: fraud hold on this supplier. Controller must review.");

    const flagId = (await detail("AP-00394")).flags[0]!.flagId;
    expect(await refusedCodes(clearFlag("U003", { flagId, note: "looks fine" }, opts))).toEqual(["CONTROLLER_ONLY"]);
    expect(await refusedCodes(clearFlag("U002", { flagId, note: "" }, opts))).toEqual(["NOTE_REQUIRED"]);
    await ok(clearFlag("U002", { flagId, note: "Called Summit on the number in the master file; transfer was genuine." }, opts));
    expect((await current("AP-00407")).status).toBe("scheduled");
    await ok(releasePayment("U003", { paymentId: b.paymentId }, opts));
  });

  it("Low: a bank error flags only the failed payment and clears itself when the retry is scheduled", async () => {
    const p = await ok(schedulePayment("U004", { invoiceId: "AP-00425" }, opts));
    await ok(releasePayment("U003", { paymentId: p.paymentId }, opts));
    await ok(simulateSettlement("U004", { paymentId: p.paymentId, outcome: "BANK_ERROR" }, opts));
    const row = (await detail("AP-00425"));
    expect(row.flags.map((f) => [f.urgency, f.scope, f.paymentId])).toEqual([["low", "payment", p.paymentId]]);
    await ok(schedulePayment("U004", { invoiceId: "AP-00425" }, opts));
    expect((await detail("AP-00425")).flags[0]!.clearedAutomatically).toBe(true);
  });

  it("view-only people can't clear flags; the server refuses", async () => {
    const p = await ok(schedulePayment("U004", { invoiceId: "AP-00425" }, opts));
    await ok(releasePayment("U003", { paymentId: p.paymentId }, opts));
    await ok(simulateSettlement("U004", { paymentId: p.paymentId, outcome: "BANK_ERROR" }, opts));
    const flagId = (await detail("AP-00425")).flags[0]!.flagId;
    expect(await refusedCodes(clearFlag("U006", { flagId, note: "" }, opts))).toEqual(["VIEW_ONLY"]); // auditor
    expect(await refusedCodes(clearFlag("U007", { flagId, note: "" }, opts))).toEqual(["VIEW_ONLY"]); // approver
  });

  it("cancel only before release, with a reason; the invoice goes back to Approved", async () => {
    const p = await ok(schedulePayment("U004", { invoiceId: "AP-00425" }, opts));
    expect(await refusedCodes(cancelPayment("U004", { paymentId: p.paymentId, reason: "" }, opts))).toEqual(["REASON_REQUIRED"]);
    await ok(cancelPayment("U004", { paymentId: p.paymentId, reason: "Supplier sent a corrected invoice" }, opts));
    expect((await detail("AP-00425")).invoice.status).toBe("Approved");
  });

  it("every action is in the audit trail with who and when", async () => {
    const p = await ok(schedulePayment("U004", { invoiceId: "AP-00425" }, opts));
    await ok(releasePayment("U003", { paymentId: p.paymentId }, opts));
    const trail = getPaymentAudit("U006", "AP-00425").map((e) => [e.action, e.actorId]);
    expect(trail).toEqual([
      ["invoice.schedule", "U004"],
      ["payment.scheduled", "U004"],
      ["payment.released", "U003"],
    ]);
  });

  it("who sees what: employees only their own requests, approvers their department", async () => {
    expect((await listPayments("U017")).awaitingPayment.map((i) => i.invoiceId)).toEqual(["AP-00425", "AP-00426"]); // Camille requested both
    expect((await listPayments("U036")).payments.map((r) => r.invoice.invoiceId)).toEqual(["AP-00422"]); // Olivia's only request
    expect((await listPayments(null))).toEqual({ payments: [], awaitingPayment: [] });
    expect(JSON.stringify((await listPayments("U002")))).not.toMatch(/"(account|institution|transit)":/); // no full bank details
  });
});
