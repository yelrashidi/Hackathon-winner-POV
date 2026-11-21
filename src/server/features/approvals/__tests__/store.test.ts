import { beforeEach, describe, expect, it } from "vitest";
import type { ApprovalInput, ApprovalPlan } from "@/contracts/approvals";
import {
  ApprovalStoreError,
  InMemoryApprovalStore,
  PENDING_APPROVAL_STATUS,
  applyDecision,
  approversOf,
  checkDecision,
  getApprovalPlans,
  getCurrentApprovalPlan,
  importApprovalPlan,
  planApprovals,
  saveApprovalPlan,
  saveDecision,
  setDefaultApprovalStore,
  type ApprovalStore,
  type DecisionResult,
  type InvoiceRef,
} from "..";
import { approveAll, loadContext } from "./dataset";

const ctx = loadContext();
const AT = new Date("2026-11-03T10:00:00Z");

// D07 Facilities $18,758: step 1 = U003 on behalf of U012 (on leave), step 2 = U002.
const input = (patch: Partial<ApprovalInput> = {}): ApprovalInput => ({
  invoiceId: "S-1",
  invoiceVersion: 1,
  vendorId: "V036",
  vendorNameRaw: "Queen Street Properties Inc.",
  departmentId: "D07",
  requesterId: "U037",
  currency: "CAD",
  totalCents: 1_875_800,
  fxRateToCad: 1,
  totalCadCents: 1_875_800,
  ...patch,
});
const ref = (i: ApprovalInput): InvoiceRef => ({
  invoiceId: i.invoiceId,
  invoiceVersion: i.invoiceVersion,
  status: PENDING_APPROVAL_STATUS,
  requesterId: i.requesterId,
  submittedBy: i.submittedBy ?? null,
  vendorId: i.vendorId,
});

let store: ApprovalStore;
beforeEach(() => {
  store = new InMemoryApprovalStore();
});

/** What the approve / reject route handler does: load current plan, check, apply, save. */
async function decide(i: ApprovalInput, actor: string, body: unknown): Promise<DecisionResult> {
  const plan = await getCurrentApprovalPlan(i.invoiceId, { invoiceVersion: i.invoiceVersion, store });
  if (!plan) throw new Error("no current plan");
  const check = checkDecision(plan, ref(i), actor, body, ctx);
  if (!check.ok) throw new Error(check.code);
  const result = applyDecision(plan, check, AT);
  await saveDecision(i.invoiceId, i.invoiceVersion, result, { store });
  return result;
}

/** A decision computed on the current stored plan, not yet saved. */
async function pendingDecision(i: ApprovalInput, actor: string): Promise<DecisionResult> {
  const plan = (await getCurrentApprovalPlan(i.invoiceId, { invoiceVersion: i.invoiceVersion, store }))!;
  const check = checkDecision(plan, ref(i), actor, { action: "approve" }, ctx);
  if (!check.ok) throw new Error(check.code);
  return applyDecision(plan, check, AT);
}

const errorCode = async (p: Promise<unknown>) => {
  try {
    await p;
    return "no error";
  } catch (e) {
    return e instanceof ApprovalStoreError ? e.code : `unexpected: ${String(e)}`;
  }
};
const withoutId = ({ planId: _id, ...rest }: ApprovalPlan) => rest;

describe("approval store — plans", () => {
  it("round-trips a plan exactly, and gives it an id", async () => {
    const plan = planApprovals(input(), ctx);
    await saveApprovalPlan(plan, { store });
    const [loaded] = await getApprovalPlans("S-1", { store });
    expect(loaded.planId).toBe("S-1#1");
    expect(withoutId(loaded)).toEqual(plan);
  });

  it("keeps every plan, all versions, oldest first", async () => {
    await saveApprovalPlan(planApprovals(input(), ctx), { store });
    await decide(input(), "U003", { action: "reject", comment: "Wrong month" });
    await saveApprovalPlan(planApprovals(input(), ctx), { store }); // resubmitted after the rejection
    await saveApprovalPlan(planApprovals(input({ invoiceVersion: 2, totalCents: 1_900_000, totalCadCents: 1_900_000 }), ctx), { store });
    const plans = await getApprovalPlans("S-1", { store });
    expect(plans.map((p) => [p.planId, p.invoiceVersion])).toEqual([["S-1#1", 1], ["S-1#2", 1], ["S-1#3", 2]]);
    expect(plans[0].steps[0]).toMatchObject({ decision: "rejected", actedBy: "U003", comment: "Wrong month" });
  });

  it("current plan: latest for the version; null once the invoice moved on or was never routed", async () => {
    await saveApprovalPlan(planApprovals(input(), ctx), { store });
    await saveApprovalPlan(planApprovals(input({ invoiceVersion: 2 }), ctx), { store });
    expect((await getCurrentApprovalPlan("S-1", { invoiceVersion: 2, store }))?.planId).toBe("S-1#2");
    expect(await getCurrentApprovalPlan("S-1", { invoiceVersion: 1, store })).toBeNull(); // superseded by version 2
    expect(await getCurrentApprovalPlan("S-1", { invoiceVersion: 3, store })).toBeNull(); // edited, not resubmitted
    expect((await getCurrentApprovalPlan("S-1", { store }))?.planId).toBe("S-1#2");
    expect(await getCurrentApprovalPlan("NOPE", { store })).toBeNull();
    expect(await getApprovalPlans("NOPE", { store })).toEqual([]);
  });

  it("refuses a plan that already carries decisions (no forged approvals); import is for seed/tests", async () => {
    const plan = planApprovals(input(), ctx);
    const approved = approveAll(plan, input(), ctx, AT);
    expect(await errorCode(saveApprovalPlan(approved, { store }))).toBe("INVALID");
    await importApprovalPlan(approved, { store });
    expect(withoutId((await getApprovalPlans("S-1", { store }))[0])).toEqual(approved);
  });

  it("refuses a second plan for a version that is in approval, or already approved", async () => {
    const i = input({ invoiceId: "S-2" });
    await saveApprovalPlan(planApprovals(i, ctx), { store });
    expect(await errorCode(saveApprovalPlan(planApprovals(i, ctx), { store }))).toBe("CONFLICT");
    await decide(i, "U003", { action: "approve" });
    await decide(i, "U002", { action: "approve" });
    expect(await errorCode(saveApprovalPlan(planApprovals(i, ctx), { store }))).toBe("CONFLICT");
  });

  it("allows a new plan after a hold is cleared", async () => {
    await saveApprovalPlan(planApprovals(input({ vendorId: null, vendorNameRaw: "Unknown Co" }), ctx), { store });
    await saveApprovalPlan(planApprovals(input(), ctx), { store });
    expect((await getCurrentApprovalPlan("S-1", { invoiceVersion: 1, store }))?.outcome).toBe("route");
  });

  it("refuses an older version, an invalid plan, and saving a stored plan again", async () => {
    await saveApprovalPlan(planApprovals(input({ invoiceVersion: 2 }), ctx), { store });
    expect(await errorCode(saveApprovalPlan(planApprovals(input(), ctx), { store }))).toBe("CONFLICT");
    expect(await errorCode(saveApprovalPlan({ ...planApprovals(input(), ctx), outcome: "yes" } as unknown as ApprovalPlan, { store }))).toBe("INVALID");
    const stored = (await getCurrentApprovalPlan("S-1", { store }))!;
    expect(await errorCode(saveApprovalPlan(stored, { store }))).toBe("INVALID");
  });

  it("hands out copies: changing a plan in memory does not change what is stored", async () => {
    const plan = planApprovals(input(), ctx);
    await saveApprovalPlan(plan, { store });
    plan.steps[0].assignedTo = "U999";
    const loaded = (await getApprovalPlans("S-1", { store }))[0];
    loaded.steps[0].decision = "approved";
    const again = (await getApprovalPlans("S-1", { store }))[0];
    expect(again.steps[0]).toMatchObject({ assignedTo: "U003", decision: "pending" });
  });

  it("the in-memory store itself returns copies, like a database would", async () => {
    await saveApprovalPlan(planApprovals(input(), ctx), { store });
    (await store.listSteps("S-1"))[0].decision = "approved";
    (await store.listPlans("S-1"))[0].outcome = "hold";
    expect((await store.listSteps("S-1"))[0].decision).toBe("pending");
    expect((await store.listPlans("S-1"))[0].outcome).toBe("route");
  });
});

describe("approval store — decisions", () => {
  it("persists actedBy, onBehalfOf, actedAs and acknowledgements, step by step", async () => {
    await saveApprovalPlan(planApprovals(input(), ctx), { store });
    await decide(input(), "U003", { action: "approve" });
    let plan = (await getCurrentApprovalPlan("S-1", { store }))!;
    expect(plan.steps[0]).toMatchObject({ decision: "approved", actedBy: "U003", onBehalfOf: "U012", actedAs: { role: "finance_manager" }, decidedAt: AT.toISOString() });
    expect(plan.steps[1].decision).toBe("pending");
    await decide(input(), "U002", { action: "approve", comment: "ok" });
    plan = (await getCurrentApprovalPlan("S-1", { store }))!;
    expect(plan.steps.map((s) => s.decision)).toEqual(["approved", "approved"]);
    expect([...approversOf(...(await getApprovalPlans("S-1", { store })))].sort()).toEqual(["U002", "U003", "U012"]);
  });

  it("two clicks at once: exactly one is saved, the other gets CONFLICT", async () => {
    await saveApprovalPlan(planApprovals(input(), ctx), { store });
    const first = await pendingDecision(input(), "U003");
    const second = await pendingDecision(input(), "U003"); // same stale copy, as from a second tab
    const outcomes = await Promise.allSettled([
      saveDecision("S-1", 1, first, { store }),
      saveDecision("S-1", 1, second, { store }),
    ]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as ApprovalStoreError).code).toBe("CONFLICT");
  });

  it("refuses a decision made on a plan that has since been replaced", async () => {
    await saveApprovalPlan(planApprovals(input(), ctx), { store });
    const stale = await pendingDecision(input(), "U003");
    await saveApprovalPlan(planApprovals(input({ invoiceVersion: 2 }), ctx), { store }); // edited + resubmitted
    expect(await errorCode(saveDecision("S-1", 1, stale, { store }))).toBe("CONFLICT"); // old version
    expect(await errorCode(saveDecision("S-1", 2, stale, { store }))).toBe("CONFLICT"); // same-looking step, other plan
  });

  it("refuses a decision on a plan that was never saved, an undecided step, or an out-of-order step", async () => {
    const unsaved = planApprovals(input(), ctx);
    const check = checkDecision(unsaved, ref(input()), "U003", { action: "approve" }, ctx);
    if (!check.ok) throw new Error(check.code);
    await saveApprovalPlan(planApprovals(input(), ctx), { store });
    expect(await errorCode(saveDecision("S-1", 1, applyDecision(unsaved, check, AT), { store }))).toBe("INVALID");

    const plan = (await getCurrentApprovalPlan("S-1", { store }))!;
    const fake = (step: ApprovalPlan["steps"][number]): DecisionResult => ({ planId: plan.planId, steps: plan.steps, step, event: "stepApproved", isLastStep: false });
    expect(await errorCode(saveDecision("S-1", 1, fake(plan.steps[0]), { store }))).toBe("INVALID"); // still pending
    const skipAhead = { ...plan.steps[1], decision: "approved" as const, actedBy: "U002", decidedAt: AT.toISOString() };
    expect(await errorCode(saveDecision("S-1", 1, fake(skipAhead), { store }))).toBe("CONFLICT");
    expect(await errorCode(saveDecision("NOPE", 1, fake(skipAhead), { store }))).toBe("NOT_FOUND");
  });

  it("payments sees every signer, including from a round voided by an edit", async () => {
    await saveApprovalPlan(planApprovals(input(), ctx), { store });
    await decide(input(), "U003", { action: "approve" }); // U003 for U012, then the invoice is edited
    const v2 = input({ invoiceVersion: 2, departmentId: "D01", requesterId: "U013" }); // → U007, U003
    await saveApprovalPlan(planApprovals(v2, ctx), { store });
    await decide(v2, "U007", { action: "approve" });
    await decide(v2, "U003", { action: "approve" });
    expect([...approversOf(...(await getApprovalPlans("S-1", { store })))].sort()).toEqual(["U003", "U007", "U012"]);
  });
});

describe("approval store — wiring", () => {
  it("uses the default store when none is passed, and stores are independent", async () => {
    const fresh = new InMemoryApprovalStore();
    setDefaultApprovalStore(fresh);
    await saveApprovalPlan(planApprovals(input({ invoiceId: "S-DEFAULT" }), ctx));
    expect(await getApprovalPlans("S-DEFAULT")).toHaveLength(1);
    expect(await getApprovalPlans("S-DEFAULT", { store })).toEqual([]);
    setDefaultApprovalStore(new InMemoryApprovalStore());
    expect(await getApprovalPlans("S-DEFAULT")).toEqual([]);
  });
});
