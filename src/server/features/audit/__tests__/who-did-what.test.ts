import { beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/contracts/actor";
import type { AuditInvoiceDetail, Person } from "@/contracts/audit-view";
import type { Db } from "@/server/db/client";
import { createSeededDb } from "@/server/db/__tests__/helpers";
import { getInvoiceAuditDetail, whoDidWhat } from "..";

/** The "who did what" chain on real seeded history, and on hand-built live cases. */

const AUDITOR: Actor = { userId: "U006", role: "auditor" };
const P = (userId: string, name: string, role: string): Person => ({ userId, name, role });
const jordan = P("U004", "Jordan Okafor", "ap_clerk");
const dev = P("U007", "Dev Malhotra", "approver");
const elise = P("U003", "Elise Tremblay", "finance_manager");
const priya = P("U020", "Priya Shah", "employee");

/** A minimal detail: only the fields whoDidWhat reads. */
function detail(over: { status: string; timeline?: unknown[]; approvals?: unknown[]; payments?: unknown[]; requester?: Person | null }): AuditInvoiceDetail {
  return {
    invoice: { invoiceId: "IN-1", status: over.status, requester: over.requester === undefined ? priya : over.requester, invoiceDate: "2026-10-20" },
    timeline: over.timeline ?? [],
    approvals: over.approvals ?? [],
    payments: over.payments ?? [],
  } as unknown as AuditInvoiceDetail;
}
const ev = (action: string, actor: Person, after: unknown = null, extra: object = {}) => ({ action, actor, after, occurredAt: "2026-11-02T14:00:00.000Z", imported: false, paymentId: null, ...extra });
const step = (seq: number, decision: string, actedBy: Person | null, assignedTo: Person, onBehalfOf: Person | null = null) => ({ seq, role: "dept_manager", decision, actedBy, assignedTo, onBehalfOf, decidedAt: actedBy ? "2026-11-02T15:00:00.000Z" : null });
const payment = (over: object = {}) => ({ paymentId: "PAY-1", attemptNo: 1, status: "settled", preparedBy: jordan, releasedBy: elise, scheduledDate: "2026-11-05", releasedAt: "2026-11-04T10:00:00.000Z", paidDate: "2026-11-05", ...over });

describe("whoDidWhat — live invoices", () => {
  it("a paid invoice: requested → checked → approved → scheduled → released, each with a name", () => {
    const steps = whoDidWhat(
      detail({ status: "Paid", timeline: [ev("invoice.status_changed", jordan, { status: "PendingApproval" })], approvals: [{ steps: [step(1, "approved", dev, dev)] }], payments: [payment()] }),
      { stepLabel: () => "Department manager" },
    );
    expect(steps.map((s) => [s.kind, s.state, s.person?.userId])).toEqual([
      ["requested", "done", "U020"],
      ["checked", "done", "U004"],
      ["approved", "done", "U007"],
      ["scheduled", "done", "U004"],
      ["released", "done", "U003"],
    ]);
    expect(steps.map((s) => s.summary)).toEqual([
      "Priya Shah (Employee) requested it",
      "Jordan Okafor (AP Clerk) did the checks and sent it to approval",
      "Dev Malhotra (Manager) approved it as Department manager",
      "Jordan Okafor (AP Clerk) scheduled the payment for 2026-11-05",
      "Elise Tremblay (Finance Manager) released it — paid 2026-11-05",
    ]);
  });

  it("a delegate's approval reads as such", () => {
    const [, , approved] = whoDidWhat(detail({ status: "Approved", approvals: [{ steps: [step(1, "approved", elise, dev, dev)] }] }));
    expect(approved!.summary).toMatch(/Elise Tremblay \(Finance Manager\) approved it as .* on behalf of Dev Malhotra/);
    expect(approved!.onBehalfOf?.userId).toBe("U007");
  });

  it("in approval: shows who it is waiting on, and the payment steps are not reached", () => {
    const steps = whoDidWhat(detail({ status: "PendingApproval", timeline: [ev("invoice.status_changed", jordan, { status: "PendingApproval" })], approvals: [{ steps: [step(1, "pending", null, dev)] }] }));
    expect(steps.map((s) => [s.kind, s.state])).toEqual([
      ["requested", "done"],
      ["checked", "done"],
      ["approved", "waiting"],
      ["scheduled", "not_yet"],
      ["released", "not_yet"],
    ]);
    expect(steps[2]!.summary).toMatch(/^Waiting on Dev Malhotra/);
  });

  it("approved, not scheduled: it is the AP Clerk's turn; scheduled, not released: the release is waiting", () => {
    expect(whoDidWhat(detail({ status: "Approved", approvals: [{ steps: [step(1, "approved", dev, dev)] }] }))[3]).toMatchObject({ kind: "scheduled", state: "waiting" });
    const steps = whoDidWhat(detail({ status: "PaymentScheduled", approvals: [{ steps: [step(1, "approved", dev, dev)] }], payments: [payment({ status: "scheduled", releasedBy: null, releasedAt: null, paidDate: null })] }));
    expect(steps[4]).toMatchObject({ kind: "released", state: "waiting" });
  });

  it("still in checks: no requester yet, checks in progress by the clerk", () => {
    const steps = whoDidWhat(detail({ status: "InReview", requester: null, timeline: [ev("invoice.line_coded", jordan)] }));
    expect(steps[0]).toMatchObject({ kind: "requested", state: "waiting" });
    expect(steps[1]).toMatchObject({ kind: "checked", state: "waiting", person: { userId: "U004" } });
  });

  it("a failed payment and a rejection are shown as such", () => {
    expect(whoDidWhat(detail({ status: "PaymentScheduled", payments: [payment({ status: "failed", failureCode: "ACCOUNT_CLOSED", paidDate: null })] }))[4]).toMatchObject({ state: "failed" });
    expect(whoDidWhat(detail({ status: "InReview", approvals: [{ steps: [step(1, "rejected", dev, dev)] }] }))[2]).toMatchObject({ state: "rejected" });
  });
});

describe("whoDidWhat — seeded history", () => {
  let db: Db;
  beforeAll(async () => {
    ({ db } = await createSeededDb({ validateHistory: false }));
  }, 120_000);

  it("a paid historical invoice names the requester, approver(s), scheduler and releaser; the checks are 'not recorded'", async () => {
    const rows = (await db.execute(
      "SELECT i.id FROM invoices i JOIN payments p ON p.invoice_id = i.id WHERE i.status = 'Paid' AND i.requester_id IS NOT NULL AND p.released_by IS NOT NULL ORDER BY i.id LIMIT 1",
    )) as unknown as { rows?: { id: string }[] } | { id: string }[];
    const id = (Array.isArray(rows) ? rows : rows.rows!)[0]!.id;
    const steps = whoDidWhat(await getInvoiceAuditDetail(AUDITOR, id, { db }));
    const byKind = (k: string) => steps.filter((s) => s.kind === k);
    expect(byKind("requested")[0]).toMatchObject({ state: "done" });
    expect(byKind("checked")[0]).toMatchObject({ state: "not_recorded" });
    expect(byKind("approved").length).toBeGreaterThan(0);
    expect(byKind("approved").every((s) => s.state === "done" && s.person)).toBe(true);
    expect(byKind("scheduled")[0]).toMatchObject({ state: "done", person: { role: "ap_clerk" } });
    expect(byKind("released")[0]!.state).toBe("done");
    // Separation of duties, visible in the chain: whoever released it approved nothing.
    const releaser = byKind("released")[0]!.person!.userId;
    expect(byKind("approved").map((s) => s.person!.userId)).not.toContain(releaser);
  });
});
