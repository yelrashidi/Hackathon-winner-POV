import { describe, expect, it } from "vitest";
import { ApprovalPlan, type ApprovalInput } from "@/contracts/approvals";
import type { Flag } from "@/contracts/flag";
import { applyDecision, approversOf, checkDecision, isAwaiting, planApprovals, type DecisionCheck } from "..";
import { historicalInputs, loadContext, readCsv, withUser } from "./dataset";

const ctx = loadContext();

// Dataset facts these tests lean on (checked in the first block, so a changed dataset fails loudly):
// D01 Operations → U007; D07 Facilities → U012 (on leave, delegate U003 = the finance manager);
// U002 Controller (manager U001); U001 CFO (no manager); U006 auditor.
const base: ApprovalInput = {
  invoiceId: "T-1",
  invoiceVersion: 1,
  vendorId: "V001",
  vendorNameRaw: "Polar Freight Lines Ltd.",
  departmentId: "D01",
  requesterId: "U013",
  totalCadCents: 300_000,
};
const inv = (patch: Partial<ApprovalInput>): ApprovalInput => ({ ...base, ...patch });
const flag = (code: string, severity: Flag["severity"], evidence: Record<string, unknown> = {}): Flag => ({
  code,
  severity,
  message: `${code} test message`,
  evidence,
  status: "open",
});
const chain = (plan: ApprovalPlan) => plan.steps.map((s) => `${s.role}:${s.assignedTo}`);

describe("dataset assumptions", () => {
  it("has the org facts the scenarios use", () => {
    expect(ctx.departments.get("D01")?.managerId).toBe("U007");
    expect(ctx.users.get("U012")).toMatchObject({ status: "on_leave", delegateId: "U003" });
    expect(ctx.users.get("U003")?.role).toBe("finance_manager");
    expect(ctx.users.get("U001")?.managerId).toBeNull();
  });

  it("turns all 13 CSV policies into structured rows", () => {
    expect(ctx.policies.map((p) => p.id)).toEqual(readCsv("approval_policies.csv").map((r) => r.rule_id));
    expect(ctx.policies.find((p) => p.id === "P03")?.steps).toEqual({
      type: "chain",
      roles: ["dept_manager", "finance_manager", "controller_admin"],
    });
  });
});

describe("planApprovals — amount tiers (P01–P04)", () => {
  it.each([
    [1_000_000, ["dept_manager:U007"]], // exactly $10,000 stays on P01
    [1_000_001, ["dept_manager:U007", "finance_manager:U003"]],
    [6_000_000, ["dept_manager:U007", "finance_manager:U003", "controller_admin:U002"]],
    [30_000_000, ["dept_manager:U007", "finance_manager:U003", "controller_admin:U002", "cfo:U001"]],
  ])("%i cents routes to %j", (cents, expected) => {
    const plan = planApprovals(inv({ totalCadCents: cents }), ctx);
    expect(plan.outcome).toBe("route");
    expect(chain(plan)).toEqual(expected);
    expect(() => ApprovalPlan.parse(plan)).not.toThrow();
  });

  it("holds an amount nobody on the chain may approve", () => {
    const plan = planApprovals(inv({ totalCadCents: 60_000_000 }), ctx); // $600k > CFO limit $500k
    expect(plan.outcome).toBe("hold");
    expect(plan.holdReasons.map((r) => r.message).join()).toMatch(/limit/);
  });

  it("routes a credit note on its absolute value and says no payment is released", () => {
    const plan = planApprovals(inv({ totalCadCents: -1_500_000 }), ctx);
    expect(plan.routingCadCents).toBe(1_500_000);
    expect(chain(plan)).toEqual(["dept_manager:U007", "finance_manager:U003"]);
    expect(plan.notes[0].message).toMatch(/Credit note/);
  });
});

describe("planApprovals — delegation and escalation (P07, P08)", () => {
  it("routes to the delegate of an on-leave manager and records on behalf of", () => {
    const plan = planApprovals(inv({ departmentId: "D07", requesterId: "U037", totalCadCents: 500_000 }), ctx);
    expect(plan.steps[0]).toMatchObject({ assignedTo: "U003", routedTo: "U012", onBehalfOf: "U012" });
    expect(plan.steps[0].resolution[0].policyId).toBe("P08");
  });

  it("never lets one person hold two steps: the delegate's finance step escalates", () => {
    const plan = planApprovals(inv({ departmentId: "D07", requesterId: "U037", totalCadCents: 1_800_000 }), ctx);
    expect(chain(plan)).toEqual(["dept_manager:U003", "finance_manager:U002"]);
    expect(plan.steps[1].onBehalfOf).toBeNull();
  });

  it("escalates self-approval to the approver's manager", () => {
    const plan = planApprovals(inv({ requesterId: "U007" }), ctx);
    expect(chain(plan)).toEqual(["dept_manager:U001"]);
    expect(plan.steps[0].resolution[0].policyId).toBe("P07");
  });

  it("excludes the clerk who submitted it as well as the requester", () => {
    const plan = planApprovals(inv({ submittedBy: "U007" }), ctx);
    expect(plan.steps[0].assignedTo).toBe("U001");
  });

  it("escalates past a terminated approver", () => {
    const plan = planApprovals(inv({}), withUser(ctx, "U007", { status: "terminated" }));
    expect(plan.steps[0].assignedTo).toBe("U001");
  });

  it("on leave without a delegate goes to the manager", () => {
    const plan = planApprovals(inv({}), withUser(ctx, "U007", { status: "on_leave", delegateId: null }));
    expect(plan.steps[0]).toMatchObject({ assignedTo: "U001", onBehalfOf: null });
  });

  it("with P08 switched off, an on-leave approver escalates instead of delegating", () => {
    const noP08 = { ...ctx, policies: ctx.policies.map((p) => (p.id === "P08" ? { ...p, active: false } : p)) };
    const plan = planApprovals(inv({ departmentId: "D07", requesterId: "U037" }), noP08);
    expect(plan.steps[0]).toMatchObject({ assignedTo: "U001", onBehalfOf: null });
  });
});

describe("planApprovals — vendor, PO and flag rules", () => {
  it("adds a finance step for a pending_review vendor (P05)", () => {
    const pending = [...ctx.vendors.values()].find((v) => v.status === "pending_review" && !v.requiresPo)!;
    const plan = planApprovals(inv({ vendorId: pending.id }), ctx);
    expect(chain(plan)).toEqual(["dept_manager:U007", "finance_manager:U003"]);
    expect(plan.steps[1].reasons[0].policyId).toBe("P05");
  });

  it("adds a finance step for a recently onboarded vendor (P05)", () => {
    const vendors = new Map(ctx.vendors);
    vendors.set("V001", { ...vendors.get("V001")!, onboardedAt: "2026-10-01" });
    const plan = planApprovals(inv({}), { ...ctx, vendors });
    expect(plan.steps.map((s) => s.role)).toContain("finance_manager");
  });

  it("adds a finance step for a Legal vendor (P06) and merges it with the amount step", () => {
    const legal = [...ctx.vendors.values()].find((v) => v.category === "Legal" && v.status === "active" && !v.requiresPo)!;
    const plan = planApprovals(inv({ vendorId: legal.id, totalCadCents: 2_000_000 }), ctx);
    expect(chain(plan)).toEqual(["dept_manager:U007", "finance_manager:U003"]);
    expect(plan.steps[1].reasons.map((r) => r.policyId)).toEqual(["P02", "P06"]);
  });

  it("holds when the vendor requires a PO and there is none (P13)", () => {
    const needsPo = [...ctx.vendors.values()].find((v) => v.requiresPo && v.status === "active")!;
    expect(planApprovals(inv({ vendorId: needsPo.id }), ctx).outcome).toBe("hold");
    expect(planApprovals(inv({ vendorId: needsPo.id, poId: "PO-X" }), ctx).outcome).toBe("route");
  });

  it("adds a finance step when validation says the PO is over balance (P12)", () => {
    const plan = planApprovals(inv({ flags: [flag("PO_OVER_BALANCE", "warn")] }), ctx);
    expect(plan.steps[1]).toMatchObject({ role: "finance_manager", policyId: "P12" });
  });

  it("holds an on-hold vendor and an unknown vendor", () => {
    const onHold = [...ctx.vendors.values()].find((v) => v.status === "on_hold")!;
    expect(planApprovals(inv({ vendorId: onHold.id }), ctx).outcome).toBe("hold");
    expect(planApprovals(inv({ vendorId: null, vendorNameRaw: "Speedy Tlres" }), ctx).holdReasons[0].message).toMatch(/Speedy Tlres/);
  });

  it("stays blocked while a block flag is open, and ignores resolved flags", () => {
    expect(planApprovals(inv({ flags: [flag("DUPLICATE_SUSPECTED", "block")] }), ctx).outcome).toBe("blocked");
    const resolved = { ...flag("DUPLICATE_SUSPECTED", "block"), status: "resolved" as const };
    expect(planApprovals(inv({ flags: [resolved] }), ctx).outcome).toBe("route");
  });

  it("routes a suspected split at the combined amount", () => {
    const plan = planApprovals(inv({ totalCadCents: 980_000, flags: [flag("SPLIT_INVOICE_SUSPECTED", "warn", { combinedCadCents: 1_960_000 })] }), ctx);
    expect(plan.routingCadCents).toBe(1_960_000);
    expect(chain(plan)).toEqual(["dept_manager:U007", "finance_manager:U003"]);
  });

  it("routes every historical invoice without throwing", () => {
    const plans = historicalInputs().map((i) => planApprovals(i, ctx));
    expect(plans.length).toBeGreaterThan(400);
    for (const p of plans) expect(() => ApprovalPlan.parse(p)).not.toThrow();
  });
});

describe("checkDecision — server-side enforcement", () => {
  const facilities = inv({ departmentId: "D07", requesterId: "U037", totalCadCents: 1_800_000 });
  const ref = { invoiceVersion: 1, requesterId: "U037", submittedBy: null };
  const plan0 = planApprovals(facilities, ctx); // U003 (for U012), then U002
  const denied = (c: DecisionCheck) => (c.ok ? "ok" : c.code);

  it.each([
    ["requester", "U037", "SELF_APPROVAL"],
    ["auditor", "U006", "ROLE_CANNOT_APPROVE"],
    ["AP clerk", "U004", "ROLE_CANNOT_APPROVE"],
    ["step-2 approver jumping the queue", "U002", "NOT_ASSIGNED"],
    ["unrelated manager", "U008", "NOT_ASSIGNED"],
    ["on-leave original approver", "U012", "USER_INACTIVE"],
    ["unknown user", "U999", "UNKNOWN_USER"],
  ])("refuses the %s", (_who, actor, code) => {
    expect(denied(checkDecision(plan0, ref, actor, { action: "approve" }, ctx))).toBe(code);
  });

  it("walks the happy path and records the delegate", () => {
    const c1 = checkDecision(plan0, ref, "U003", { action: "approve" }, ctx);
    if (!c1.ok) throw new Error(c1.reason);
    const r1 = applyDecision(plan0, c1, "U003", { action: "approve" }, new Date("2026-11-03T10:00:00Z"));
    expect(r1).toMatchObject({ event: "stepApproved", isLastStep: false });
    expect(r1.step).toMatchObject({ actedBy: "U003", onBehalfOf: "U012" });

    const plan1 = { ...plan0, steps: r1.steps };
    expect(denied(checkDecision(plan1, ref, "U003", { action: "approve" }, ctx))).toBe("ALREADY_SIGNED");
    expect(isAwaiting(plan1, "U002", ctx)).toBe(true);

    const c2 = checkDecision(plan1, ref, "U002", { action: "approve" }, ctx);
    if (!c2.ok) throw new Error(c2.reason);
    const r2 = applyDecision(plan1, c2, "U002", { action: "approve" }, new Date("2026-11-03T11:00:00Z"));
    expect(r2.isLastStep).toBe(true);
    expect([...approversOf({ steps: r2.steps })].sort()).toEqual(["U002", "U003", "U012"]);

    expect(denied(checkDecision({ ...plan0, steps: r2.steps }, ref, "U001", { action: "approve" }, ctx))).toBe("ALREADY_DECIDED");
  });

  it("requires a reason to reject, and a rejection ends the plan", () => {
    expect(denied(checkDecision(plan0, ref, "U003", { action: "reject", comment: "  " }, ctx))).toBe("COMMENT_REQUIRED");
    const c = checkDecision(plan0, ref, "U003", { action: "reject", comment: "Goods not received" }, ctx);
    if (!c.ok) throw new Error(c.reason);
    const r = applyDecision(plan0, c, "U003", { action: "reject", comment: "Goods not received" }, new Date());
    expect(r.event).toBe("stepRejected");
    expect(denied(checkDecision({ ...plan0, steps: r.steps }, ref, "U002", { action: "approve" }, ctx))).toBe("ALREADY_DECIDED");
  });

  it("refuses a plan made for an older invoice version (material edit voids approvals)", () => {
    expect(denied(checkDecision(plan0, { ...ref, invoiceVersion: 2 }, "U003", { action: "approve" }, ctx))).toBe("STALE_PLAN");
  });

  it("refuses to act on a held invoice", () => {
    const held = planApprovals(inv({ vendorId: null }), ctx);
    expect(denied(checkDecision(held, { ...ref, requesterId: "U013" }, "U007", { action: "approve" }, ctx))).toBe("NOT_ROUTED");
  });

  it("lets the delegate act when the assignee goes on leave after routing", () => {
    const plan = planApprovals(inv({}), ctx); // U007
    const later = withUser(ctx, "U007", { status: "on_leave", delegateId: "U010" });
    const c = checkDecision(plan, { invoiceVersion: 1, requesterId: "U013", submittedBy: null }, "U010", { action: "approve" }, later);
    expect(c).toMatchObject({ ok: true, onBehalfOf: "U007" });
    expect(isAwaiting(plan, "U010", later)).toBe(true);
  });
});
