import { describe, expect, it } from "vitest";
import type { ApprovalPolicy } from "@/contracts/approvals";
import type { Flag } from "@/contracts/flag";
import type { DirectoryUser } from "@/server/features/approvals";
import { checkClearFlag, checkRelease, checkSchedule, defaultPayDate, type ReleaseInput } from "../rules";
import type { BankAccountVersion, FlagRec, InvoiceRec, PaymentRec } from "../types";

// One test per rule. Inputs are built here so each test changes exactly one thing.

const user = (id: string, role: DirectoryUser["role"], extra: Partial<DirectoryUser> = {}): DirectoryUser => ({
  id, fullName: `Person ${id}`, role, departmentId: "D01", managerId: null, approvalLimitCents: 0,
  status: "active", statusSince: null, delegateId: null, ...extra,
});

const FM = user("FM", "finance_manager");
const CTRL = user("CTRL", "controller_admin");
const CLERK = user("CLERK", "ap_clerk");

const policies: ApprovalPolicy[] = [
  { id: "P09", version: 1, active: true, ruleType: "payment_release", priority: 8, conditions: { kind: "amount_up_to", cadCents: 10_000_000 }, steps: { type: "release_by", role: "finance_manager" }, description: "" },
  { id: "P10", version: 1, active: true, ruleType: "payment_release", priority: 9, conditions: { kind: "amount_over", cadCents: 10_000_000 }, steps: { type: "release_by", role: "controller_admin" }, description: "" },
];

const invoice: InvoiceRec = {
  id: "INV", version: 1, status: "PaymentScheduled", vendorId: "V1", vendorInvoiceNumber: "A-1", invoiceDate: "2026-11-01",
  dueDate: "2026-11-23", currency: "CAD", totalCents: 500_000, totalCadCents: 500_000, fxRate: "1",
  departmentId: "D01", requesterId: "REQ", isCreditNote: false,
};

const payment: PaymentRec = {
  paymentId: "PAY", invoiceId: "INV", vendorId: "V1", attemptNo: 1, status: "scheduled", method: "EFT", currency: "CAD",
  amountCents: 500_000, amountCadCents: 500_000, fxRateToCad: "1", scheduledDate: "2026-11-23", bankVersion: 1, bankLast4: "1234",
  releasedAt: null, settledAt: null, failedAt: null, failure: null, cancelledAt: null, cancelledBy: null, cancelReason: null,
  holdReason: null, preparedBy: "CLERK", releasedBy: null, bankReference: null,
};

const account: BankAccountVersion = {
  vendorId: "V1", version: 1, status: "verified", institution: "001", transit: "12345", account: "1111234", last4: "1234",
  currency: "CAD", changedAt: null, channel: null, requestedBy: null, verifiedBy: null, verifiedAt: null, closedReason: null,
};

const flag = (urgency: FlagRec["urgency"], extra: Partial<FlagRec> = {}): FlagRec => ({
  flagId: "F", urgency, reasonCode: urgency === "critical" ? "FRAUD_HOLD" : urgency === "high" ? "ACCOUNT_CLOSED" : "BANK_ERROR",
  message: "m", scope: urgency === "low" ? "payment" : "supplier", vendorId: "V1", invoiceId: "INV", paymentId: "OLD",
  createdAt: "2026-11-21T10:00:00.000Z", clearedBy: null, clearedAt: null, clearNote: null, clearedAutomatically: false, ...extra,
});

const base = (over: Partial<ReleaseInput> = {}): ReleaseInput => ({
  actor: FM, payment, invoice, vendor: { id: "V1", legalName: "Vendor One", status: "active" }, bankAccounts: [account],
  approval: { approverIds: ["APPROVER"], basis: { vendorId: "V1", currency: "CAD", totalCents: 500_000 } },
  paymentFlags: [], invoiceFlags: [], policies, ...over,
});

const codes = (over: Partial<ReleaseInput> = {}) => checkRelease(base(over)).reasons.map((r) => r.code);

describe("release rules", () => {
  it("allows the Finance Manager to release a clean payment under the limit", () => {
    expect(checkRelease(base())).toEqual({ allowed: true, reasons: [] });
  });

  it("only the Finance Manager or Controller can release (P09/P10)", () => {
    expect(codes({ actor: user("CLERK2", "ap_clerk") })).toEqual(["ROLE_CANNOT_RELEASE"]);
    expect(codes({ actor: user("A", "approver") })).toEqual(["ROLE_CANNOT_RELEASE"]);
    expect(codes({ actor: undefined })).toContain("NOT_SIGNED_IN");
  });

  it("over $100k CAD the Finance Manager is refused and the Controller may release (P09/P10, from policy)", () => {
    const big = { ...payment, amountCents: 10_000_001, amountCadCents: 10_000_001 };
    const approval = { approverIds: [], basis: { vendorId: "V1", currency: "CAD" as const, totalCents: 10_000_001 } };
    const r = checkRelease(base({ payment: big, approval }));
    expect(r.reasons.map((x) => x.code)).toEqual(["OVER_RELEASE_LIMIT"]);
    expect(r.reasons[0].message).toContain("$100,000.00");
    expect(checkRelease(base({ actor: CTRL, payment: big, approval })).allowed).toBe(true);
    // exactly at the limit is fine
    const atLimit = { ...payment, amountCents: 10_000_000, amountCadCents: 10_000_000 };
    expect(checkRelease(base({ payment: atLimit, approval: { ...approval, basis: { ...approval.basis, totalCents: 10_000_000 } } })).allowed).toBe(true);
  });

  it("USD is limited on its CAD amount at the invoice-date rate, and a CAD amount that doesn't match total × rate is refused", () => {
    const usd = { ...payment, currency: "USD" as const, amountCents: 7_300_000, amountCadCents: 10_001_000, fxRateToCad: "1.37" };
    const approval = { approverIds: [], basis: { vendorId: "V1", currency: "USD" as const, totalCents: 7_300_000 } };
    const usdAccount = { ...account, currency: "USD" as const };
    expect(codes({ payment: usd, approval, bankAccounts: [usdAccount] })).toEqual(["OVER_RELEASE_LIMIT"]);
    const wrongCad = { ...usd, amountCadCents: 7_300_000 };
    expect(codes({ payment: wrongCad, approval, bankAccounts: [usdAccount] })).toEqual(["FX_MISMATCH"]);
  });

  it("whoever approved the invoice can't release it, including on behalf of someone (P11)", () => {
    expect(codes({ approval: { approverIds: ["FM"], basis: { vendorId: "V1", currency: "CAD", totalCents: 500_000 } } })).toEqual(["APPROVED_IT"]);
  });

  it("whoever scheduled the payment can't release it (Q5)", () => {
    expect(codes({ payment: { ...payment, preparedBy: "FM" } })).toEqual(["SCHEDULED_IT"]);
  });

  it("whoever requested the invoice can't release it (Q6)", () => {
    expect(codes({ invoice: { ...invoice, requesterId: "FM" } })).toEqual(["REQUESTED_IT"]);
  });

  it("someone on leave or gone can't release (Q7)", () => {
    expect(codes({ actor: { ...FM, status: "on_leave", statusSince: "2026-11-01" } })).toEqual(["NOT_ACTIVE"]);
    expect(codes({ actor: { ...FM, status: "terminated" } })).toEqual(["NOT_ACTIVE"]);
  });

  it("only a verified bank account is paid", () => {
    expect(codes({ bankAccounts: [{ ...account, status: "pending" }] })).toContain("BANK_NOT_VERIFIED");
    expect(codes({ bankAccounts: [{ ...account, status: "closed", closedReason: "ACCOUNT_CLOSED" }] })).toEqual(["BANK_ACCOUNT_CLOSED"]);
    expect(codes({ bankAccounts: [account, { ...account, version: 2, status: "pending", last4: "9999", changedAt: "2026-10-27", channel: "email_request" }] })).toEqual(["BANK_CHANGE_PENDING"]);
  });

  it("a USD payment to a CAD-only account is refused before release", () => {
    const usd = { ...payment, currency: "USD" as const, fxRateToCad: "1.4", amountCadCents: 700_000 };
    const approval = { approverIds: [], basis: { vendorId: "V1", currency: "USD" as const, totalCents: 500_000 } };
    expect(codes({ payment: usd, approval })).toEqual(["BANK_CURRENCY_MISMATCH"]);
  });

  it("pays only the approved payee and no more than the approved amount (R7)", () => {
    expect(codes({ approval: { approverIds: [], basis: { vendorId: "V2", currency: "CAD", totalCents: 500_000 } } })).toEqual(["PAYEE_MISMATCH"]);
    expect(codes({ approval: { approverIds: [], basis: { vendorId: "V1", currency: "CAD", totalCents: 499_999 } } })).toEqual(["AMOUNT_OVER_APPROVED"]);
  });

  it("an open blocking flag from validation or duplicates stops release", () => {
    const dup: Flag = { code: "DUPLICATE_INVOICE", severity: "block", message: "Same as AP-00001", evidence: {}, status: "open" };
    expect(codes({ invoiceFlags: [dup] })).toEqual(["BLOCKING_FLAG"]);
    expect(codes({ invoiceFlags: [{ ...dup, severity: "warn" }] })).toEqual([]);
  });

  it("a credit note is never paid", () => {
    expect(codes({ invoice: { ...invoice, isCreditNote: true } })).toEqual(["CREDIT_NOTE"]);
  });

  it("Critical blocks release with the fraud-hold message", () => {
    const r = checkRelease(base({ paymentFlags: [flag("critical")] }));
    expect(r.allowed).toBe(false);
    expect(r.reasons).toContainEqual({ code: "SUPPLIER_FRAUD_HOLD", message: "Stopped: fraud hold on this supplier. Controller must review." });
  });

  it("a High flag doesn't block release on its own", () => {
    expect(checkRelease(base({ paymentFlags: [flag("high")] }))).toEqual({ allowed: true, reasons: [] });
  });

  it("lists every reason at once", () => {
    expect(codes({ actor: { ...CLERK, status: "on_leave" }, payment: { ...payment, preparedBy: "CLERK" } })).toEqual(["ROLE_CANNOT_RELEASE", "NOT_ACTIVE", "SCHEDULED_IT"]);
  });
});

describe("clearing urgency flags", () => {
  const ids = (actor: DirectoryUser | undefined, f: FlagRec, scheduledBy: string | null, note: string) =>
    checkClearFlag(actor, f, scheduledBy, note).map((r) => r.code);

  it("only the Controller can clear Critical, never whoever scheduled the payment", () => {
    expect(ids(FM, flag("critical"), "CLERK", "checked")).toEqual(["CONTROLLER_ONLY"]);
    expect(ids(CTRL, flag("critical"), "CLERK", "called the supplier")).toEqual([]);
    expect(ids(CTRL, flag("critical"), "CTRL", "x")).toEqual(["SCHEDULED_IT"]);
  });

  it("a note is required for Critical and High, not for Low", () => {
    expect(ids(CTRL, flag("critical"), "CLERK", " ")).toEqual(["NOTE_REQUIRED"]);
    expect(ids(CLERK, flag("high"), "X", "")).toEqual(["NOTE_REQUIRED"]);
    expect(ids(CLERK, flag("low"), "X", "")).toEqual([]);
  });

  it("view-only people can't clear any flag", () => {
    for (const role of ["employee", "approver", "auditor"] as const) {
      expect(ids(user("V", role), flag("low"), "X", "n")).toEqual(["VIEW_ONLY"]);
    }
  });
});

describe("scheduling and pay dates", () => {
  const sched = (over: Partial<Parameters<typeof checkSchedule>[0]> = {}) =>
    checkSchedule({
      actor: CLERK, invoice: { ...invoice, status: "Approved" }, vendor: { id: "V1", legalName: "Vendor One", status: "active" },
      attempts: [], bankAccounts: [account], supplierFlags: [], payDate: "2026-11-23", today: "2026-11-21", ...over,
    });

  it("an AP clerk schedules an approved invoice to the verified account", () => {
    const r = sched();
    expect(r.allowed).toBe(true);
    expect(r.account?.version).toBe(1);
  });

  it("one active attempt per invoice", () => {
    expect(sched({ attempts: [payment] }).reasons.map((x) => x.code)).toEqual(["ALREADY_ACTIVE"]);
  });

  it("after a bank-detail failure, retry waits for new verified details", () => {
    const failed = { ...payment, status: "failed" as const, failure: { code: "ACCOUNT_CLOSED" as const, message: "m", nextStep: "n", retryRule: "FIX_BANK_DETAILS" as const, urgency: "high" as const } };
    const closed = { ...account, status: "closed" as const };
    expect(sched({ attempts: [failed], bankAccounts: [closed] }).reasons.map((x) => x.code)).toEqual(["FIX_BANK_DETAILS_FIRST"]);
    expect(sched({ attempts: [failed], bankAccounts: [closed, { ...account, version: 2, last4: "5678" }] }).allowed).toBe(true);
  });

  it("while a supplier has a Critical flag, a new payment starts on hold", () => {
    expect(sched({ supplierFlags: [flag("critical")] }).startsOnHold).toBe(true);
  });

  it("weekend due dates move back to the Friday before; a past due date pays today", () => {
    expect(defaultPayDate("2026-11-28", "2026-11-21")).toBe("2026-11-27"); // Sat → Fri
    expect(defaultPayDate("2026-11-29", "2026-11-21")).toBe("2026-11-27"); // Sun → Fri
    expect(defaultPayDate("2026-11-02", "2026-11-20")).toBe("2026-11-20"); // overdue → today (Fri)
    expect(defaultPayDate("2026-11-02", "2026-11-21")).toBe("2026-11-23"); // overdue on a Saturday → Monday
    expect(sched({ payDate: "2026-11-28" }).warnings[0]).toContain("Saturday");
  });
});
