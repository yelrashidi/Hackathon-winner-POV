import { describe, expect, it } from "vitest";
import { ApprovalPlan, ApprovalPolicy, type ApprovalInput } from "@/contracts/approvals";
import type { Flag } from "@/contracts/flag";
import {
  applyDecision,
  approvalAging,
  approversOf,
  businessDaysBetween,
  checkDecision,
  isAwaiting,
  planApprovals,
  policiesFromCsv,
  reapprovalReasons,
  waitingOn,
  type ApprovalContext,
  type DecisionCheck,
  type DirectoryUser,
  type InvoiceRef,
} from "..";
import { historicalInputs, loadContext, readCsv, withUser } from "./dataset";

const ctx = loadContext();

// Dataset facts these tests lean on (checked first, so a changed dataset fails loudly):
// D01 Operations → U007 (limit $10k, manager U001); D07 Facilities → U012 (on leave, delegate
// U003 = the finance manager); D04 Finance → U002 (the Controller, manager U001); D08 → U001 (CFO,
// no manager). U006 auditor, U004 AP clerk, U013/U037/U030 employees, U015 terminated.
const base: ApprovalInput = {
  invoiceId: "T-1",
  invoiceVersion: 1,
  vendorId: "V001",
  vendorNameRaw: "Polar Freight Lines Ltd.",
  departmentId: "D01",
  requesterId: "U013",
  currency: "CAD",
  totalCents: 300_000,
  fxRateToCad: 1,
  totalCadCents: 300_000,
};
/** CAD invoice for `cents` unless the patch says otherwise. */
const inv = (patch: Partial<ApprovalInput> & { cents?: number } = {}): ApprovalInput => {
  const { cents, ...rest } = patch;
  return { ...base, ...(cents !== undefined ? { totalCents: cents, totalCadCents: cents } : {}), ...rest };
};
const flag = (code: string, severity: Flag["severity"], extra: Partial<Flag> = {}): Flag => ({
  code,
  severity,
  message: `${code} test message`,
  evidence: {},
  status: "open",
  ...extra,
});
const chain = (plan: ApprovalPlan) => plan.steps.map((s) => `${s.role}:${s.assignedTo}`);
const text = (rs: { message: string }[]) => rs.map((r) => r.message).join(" | ");
const refFor = (i: ApprovalInput, patch: Partial<InvoiceRef> = {}): InvoiceRef => ({
  invoiceId: i.invoiceId,
  invoiceVersion: i.invoiceVersion,
  status: "PendingApproval",
  requesterId: i.requesterId,
  submittedBy: i.submittedBy ?? null,
  vendorId: i.vendorId,
  ...patch,
});
const code = (c: DecisionCheck) => (c.ok ? "ok" : c.code);
const withVendor = (c: ApprovalContext, id: string, patch: Record<string, unknown>): ApprovalContext => {
  const vendors = new Map(c.vendors);
  vendors.set(id, { ...vendors.get(id)!, ...patch });
  return { ...c, vendors };
};
const addUser = (c: ApprovalContext, u: DirectoryUser): ApprovalContext => ({ ...c, users: new Map(c.users).set(u.id, u) });

/** Approve every step with whoever the plan is waiting on; returns the finished plan. */
function walk(plan: ApprovalPlan, i: ApprovalInput, c: ApprovalContext = ctx): ApprovalPlan {
  let p = plan;
  for (let guard = 0; guard < 10; guard++) {
    const who = waitingOn(p, refFor(i), c)?.assignee;
    if (!who) throw new Error(`${plan.invoiceId}: nobody to act on ${JSON.stringify(p.steps.map((s) => s.decision))}`);
    const ack = p.attention.map((a) => a.code); // a real approver reads and acknowledges each exception
    const check = checkDecision(p, refFor(i), who, { action: "approve", acknowledgedFlags: ack }, c);
    if (!check.ok) throw new Error(`${plan.invoiceId}: ${who} refused: ${check.code} ${check.reason}`);
    const r = applyDecision(p, check, new Date("2026-11-03T10:00:00Z"));
    p = { ...p, steps: r.steps };
    if (r.isLastStep) return p;
  }
  throw new Error("walk did not finish");
}

describe("dataset assumptions", () => {
  it("has the org facts the scenarios use", () => {
    expect(ctx.departments.get("D01")?.managerId).toBe("U007");
    expect(ctx.departments.get("D04")?.managerId).toBe("U002");
    expect(ctx.users.get("U012")).toMatchObject({ status: "on_leave", delegateId: "U003" });
    expect(ctx.users.get("U003")?.role).toBe("finance_manager");
    expect(ctx.users.get("U001")?.managerId).toBeNull();
    expect(ctx.users.get("U015")?.status).toBe("terminated");
  });
});

describe("policies", () => {
  it("turns all 13 CSV policies into structured rows", () => {
    expect(ctx.policies.map((p) => p.id)).toEqual(readCsv("approval_policies.csv", ["rule_id"]).map((r) => r.rule_id));
    expect(ctx.policies.find((p) => p.id === "P03")?.steps).toEqual({ type: "chain", roles: ["dept_manager", "finance_manager", "controller_admin"] });
    expect(ctx.policies.find((p) => p.id === "P12")?.conditions).toEqual({ kind: "flag_raised", code: "PO_OVER_BALANCE" });
  });

  it("rejects a chain keyed on something other than an amount (it could replace the amount tiers)", () => {
    const bad = { ...ctx.policies[0], conditions: { kind: "vendor_category", category: "Legal" } };
    expect(ApprovalPolicy.safeParse(bad).success).toBe(false);
  });

  it("rejects a release rule filed as an approval rule", () => {
    const bad = { ...ctx.policies[0], steps: { type: "release_by", role: "finance_manager" } };
    expect(ApprovalPolicy.safeParse(bad).success).toBe(false);
  });

  it("refuses to seed a policy row it does not understand", () => {
    expect(() => policiesFromCsv([{ rule_id: "P99", rule_type: "approval", condition: "Moon is full", required: "cfo", notes: "" }])).toThrow(/P99/);
  });
});

describe("routing — amounts", () => {
  it.each([
    [1_000_000, ["dept_manager:U007"]], // exactly $10,000 stays on P01
    [1_000_001, ["dept_manager:U007", "finance_manager:U003"]],
    [6_000_000, ["dept_manager:U007", "finance_manager:U003", "controller_admin:U002"]],
    [30_000_000, ["dept_manager:U007", "finance_manager:U003", "controller_admin:U002", "cfo:U001"]],
  ])("%i cents routes to %j", (cents, expected) => {
    const plan = planApprovals(inv({ cents }), ctx);
    expect(plan.outcome).toBe("route");
    expect(chain(plan)).toEqual(expected);
    expect(() => ApprovalPlan.parse(plan)).not.toThrow();
  });

  it("holds an amount nobody may approve ($600k > the CFO's $500k)", () => {
    const plan = planApprovals(inv({ cents: 60_000_000 }), ctx);
    expect(plan.outcome).toBe("hold");
    expect(text(plan.holdReasons)).toMatch(/limit/);
  });

  it("routes a credit note on its absolute value and says no payment is released", () => {
    const plan = planApprovals(inv({ cents: -1_500_000 }), ctx);
    expect(plan.routingCadCents).toBe(1_500_000);
    expect(chain(plan)).toEqual(["dept_manager:U007", "finance_manager:U003"]);
    expect(text(plan.notes)).toMatch(/Credit note/);
  });

  it("flags a $0 invoice for a second look", () => {
    expect(text(planApprovals(inv({ cents: 0 }), ctx).notes)).toMatch(/\$0\.00/);
  });

  it("routes a converted USD invoice on its CAD value", () => {
    const plan = planApprovals(inv({ currency: "USD", totalCents: 900_000, fxRateToCad: 1.37, totalCadCents: 1_233_000 }), ctx);
    expect(plan.outcome).toBe("route");
    expect(chain(plan)).toEqual(["dept_manager:U007", "finance_manager:U003"]); // $12,330 CAD > $10k
  });

  it.each([
    ["USD never converted", { currency: "USD", totalCents: 900_000, fxRateToCad: 1.37, totalCadCents: 900_000 }],
    ["USD at rate 1", { currency: "USD", totalCents: 900_000, fxRateToCad: 1, totalCadCents: 900_000 }],
    ["CAD with an FX rate", { currency: "CAD", totalCents: 900_000, fxRateToCad: 1.37, totalCadCents: 1_233_000 }],
    ["sign flipped", { currency: "CAD", totalCents: -900_000, fxRateToCad: 1, totalCadCents: 900_000 }],
  ])("holds when the CAD amount is inconsistent: %s", (_name, patch) => {
    expect(planApprovals(inv(patch), ctx).outcome).toBe("hold");
  });

  it("rejects amounts JavaScript cannot represent exactly", () => {
    expect(() => planApprovals(inv({ cents: Number.MAX_SAFE_INTEGER + 2 }), ctx)).toThrow();
    expect(() => planApprovals(inv({ cents: 1.5 }), ctx)).toThrow();
  });
});

describe("routing — who may never sign (separation of duties)", () => {
  it("escalates self-approval to the approver's manager (P07)", () => {
    const plan = planApprovals(inv({ requesterId: "U007" }), ctx);
    expect(chain(plan)).toEqual(["dept_manager:U001"]);
    expect(plan.steps[0]!.resolution[0]!.policyId).toBe("P07");
  });

  it("excludes the submitter, the PO requester and whoever overrode a flag", () => {
    expect(planApprovals(inv({ submittedBy: "U007" }), ctx).steps[0]!.assignedTo).toBe("U001");
    expect(planApprovals(inv({ poId: "PO-1", poRequesterId: "U007" }), ctx).steps[0]!.assignedTo).toBe("U001");
    const overridden = flag("DUPLICATE_SUSPECTED", "block", { status: "overridden", resolvedBy: "U007", resolutionNote: "Different month" });
    const plan = planApprovals(inv({ flags: [overridden] }), ctx);
    expect(plan.outcome).toBe("route");
    expect(plan.steps[0]!.assignedTo).toBe("U001");
    expect(text(plan.notes)).toMatch(/overridden by Dev Malhotra/);
  });

  it("never lets a delegate approve their absent boss's OWN request", () => {
    // Liam (on leave) requested it. His delegate would be signing for Liam, i.e. Liam approving Liam.
    const plan = planApprovals(inv({ departmentId: "D07", requesterId: "U012" }), ctx);
    expect(plan.steps[0]).toMatchObject({ assignedTo: "U001", onBehalfOf: null });
  });

  it("never lets the delegate approve their own request on someone else's behalf", () => {
    const plan = planApprovals(inv({ departmentId: "D07", requesterId: "U003" }), ctx);
    expect(plan.steps[0]).toMatchObject({ assignedTo: "U001", onBehalfOf: null });
  });

  it("never lets one person hold two steps: the delegate's finance step escalates", () => {
    const plan = planApprovals(inv({ departmentId: "D07", requesterId: "U037", cents: 1_800_000 }), ctx);
    expect(chain(plan)).toEqual(["dept_manager:U003", "finance_manager:U002"]);
    expect(plan.steps[0]!.onBehalfOf).toBe("U012");
    expect(plan.steps[1]!.onBehalfOf).toBeNull();
  });

  it("tries a second holder of the role before escalating", () => {
    const twoFms = addUser(ctx, { ...ctx.users.get("U003")!, id: "U099", fullName: "Second FM", delegateId: null });
    const plan = planApprovals(inv({ requesterId: "U003", cents: 2_000_000 }), twoFms);
    expect(chain(plan)).toEqual(["dept_manager:U007", "finance_manager:U099"]);
    expect(text(plan.steps[1]!.resolution)).toMatch(/Elise Tremblay \(U003\) requested this invoice/);
  });

  it("collapses roles only when nobody else is left: Finance dept > $250k", () => {
    // Marcus is both Finance's manager and the Controller, so 4 roles have 3 people.
    const plan = planApprovals(inv({ departmentId: "D04", requesterId: "U030", cents: 30_000_000 }), ctx);
    expect(plan.outcome).toBe("route");
    expect(chain(plan)).toEqual(["dept_manager:U002", "finance_manager:U003", "controller_admin:U001"]);
    expect(plan.steps[2]!.alsoCovers).toEqual(["cfo"]);
  });

  it("holds when the only approver above is the requester (the CFO's own purchase)", () => {
    const plan = planApprovals(inv({ departmentId: "D08", requesterId: "U001" }), ctx);
    expect(plan.outcome).toBe("hold");
    expect(text(plan.holdReasons)).toMatch(/no manager/);
  });
});

describe("routing — leave, termination, odd org data", () => {
  it("routes to the delegate of an on-leave manager and records on behalf of (P08)", () => {
    const plan = planApprovals(inv({ departmentId: "D07", requesterId: "U037" }), ctx);
    expect(plan.steps[0]).toMatchObject({ assignedTo: "U003", routedTo: "U012", onBehalfOf: "U012" });
    expect(plan.steps[0]!.resolution[0]!.policyId).toBe("P08");
  });

  it.each([
    ["delegate cannot approve (an employee)", { delegateId: "U037" }],
    ["delegate does not exist", { delegateId: "U404" }],
    ["delegate is themselves", { delegateId: "U012" }],
  ])("falls back to the absent approver's manager when the %s", (_n, patch) => {
    const plan = planApprovals(inv({ departmentId: "D07", requesterId: "U038" }), withUser(ctx, "U012", patch));
    expect(plan.steps[0]).toMatchObject({ assignedTo: "U001", onBehalfOf: null });
  });

  it("does not chain delegations: delegate also on leave → absent approver's manager", () => {
    const c = withUser(ctx, "U003", { status: "on_leave", delegateId: "U002" });
    const plan = planApprovals(inv({ departmentId: "D07", requesterId: "U037" }), c);
    expect(plan.steps[0]!.assignedTo).toBe("U001");
  });

  it("escalates past terminated, suspended and on-leave-without-delegate approvers", () => {
    expect(planApprovals(inv(), withUser(ctx, "U007", { status: "terminated" })).steps[0]!.assignedTo).toBe("U001");
    expect(planApprovals(inv(), withUser(ctx, "U007", { status: "suspended" })).steps[0]!.assignedTo).toBe("U001");
    expect(planApprovals(inv(), withUser(ctx, "U007", { status: "on_leave", delegateId: null })).steps[0]).toMatchObject({ assignedTo: "U001", onBehalfOf: null });
  });

  it("with P08 switched off, an on-leave approver escalates instead of delegating", () => {
    const noP08 = { ...ctx, policies: ctx.policies.map((p) => (p.id === "P08" ? { ...p, active: false } : p)) };
    expect(planApprovals(inv({ departmentId: "D07", requesterId: "U037" }), noP08).steps[0]).toMatchObject({ assignedTo: "U001", onBehalfOf: null });
  });

  it("escalates past an approver whose limit is too low to carry the invoice alone", () => {
    const plan = planApprovals(inv({ cents: 800_000 }), withUser(ctx, "U007", { approvalLimitCents: 500_000 }));
    expect(plan.steps[0]!.assignedTo).toBe("U001");
    expect(text(plan.steps[0]!.resolution)).toMatch(/limit/);
  });

  it("survives a management chain that loops", () => {
    const c = withUser(ctx, "U007", { status: "terminated", managerId: "U013" }); // U013 reports to U007
    const plan = planApprovals(inv(), c);
    expect(plan.outcome).toBe("hold");
    expect(text(plan.holdReasons)).toMatch(/loops/);
  });

  it.each([
    ["terminated requester", { requesterId: "U015" }, /terminated/],
    ["auditor requester", { requesterId: "U006" }, /cannot request/],
    ["unknown requester", { requesterId: "U404" }, /not a known user/],
    ["unknown department", { departmentId: "D99" }, /does not exist/],
  ])("holds a %s", (_n, patch, why) => {
    const plan = planApprovals(inv(patch), ctx);
    expect(plan.outcome).toBe("hold");
    expect(text(plan.holdReasons)).toMatch(why);
  });

  it("notes cross-department charging and approvers who report to the requester", () => {
    expect(text(planApprovals(inv({ requesterId: "U022" }), ctx).notes)).toMatch(/works in Sales/);
    expect(text(planApprovals(inv({ lineDepartmentIds: ["D01", "D05"] }), ctx).notes)).toMatch(/also charged to IT/);
    expect(text(planApprovals(inv({ requesterId: "U001" }), ctx).notes)).toMatch(/reports to the requester/);
  });
});

describe("routing — vendor, PO and flag rules", () => {
  it("adds a finance step for a pending_review vendor (P05)", () => {
    const pending = [...ctx.vendors.values()].find((v) => v.status === "pending_review" && !v.requiresPo)!;
    const plan = planApprovals(inv({ vendorId: pending.id }), ctx);
    expect(chain(plan)).toEqual(["dept_manager:U007", "finance_manager:U003"]);
    expect(plan.steps[1]!.reasons[0]!.policyId).toBe("P05");
  });

  it.each([
    ["onboarded last month", "2026-10-01"],
    ["onboarding date in the future", "2027-01-01"],
    ["unreadable onboarding date", "soon"],
    ["no onboarding date", null],
  ])("treats a vendor with %s as new (P05)", (_n, onboardedAt) => {
    const plan = planApprovals(inv(), withVendor(ctx, "V001", { onboardedAt }));
    expect(plan.steps.map((s) => s.role)).toContain("finance_manager");
  });

  it("adds a finance step for a Legal vendor (P06), merged with the amount step, whatever the spacing/case", () => {
    const legal = [...ctx.vendors.values()].find((v) => v.category === "Legal" && v.status === "active" && !v.requiresPo)!;
    const plan = planApprovals(inv({ vendorId: legal.id, cents: 2_000_000 }), ctx);
    expect(chain(plan)).toEqual(["dept_manager:U007", "finance_manager:U003"]);
    expect(plan.steps[1]!.reasons.map((r) => r.policyId)).toEqual(["P02", "P06"]);
    expect(chain(planApprovals(inv(), withVendor(ctx, "V001", { category: "  lEGAL " })))).toContain("finance_manager:U003");
  });

  it("holds when the vendor requires a PO and there is none (P13)", () => {
    const needsPo = [...ctx.vendors.values()].find((v) => v.requiresPo && v.status === "active")!;
    expect(planApprovals(inv({ vendorId: needsPo.id }), ctx).outcome).toBe("hold");
    expect(planApprovals(inv({ vendorId: needsPo.id, poId: "   " }), ctx).outcome).toBe("hold");
    expect(planApprovals(inv({ vendorId: needsPo.id, poId: "PO-X" }), ctx).outcome).toBe("route");
  });

  it("PO over balance adds a finance step (P12), even after a clerk overrides the flag", () => {
    expect(planApprovals(inv({ flags: [flag("PO_OVER_BALANCE", "warn")] }), ctx).steps[1]).toMatchObject({ role: "finance_manager", policyId: "P12" });
    const overridden = flag("PO_OVER_BALANCE", "warn", { status: "overridden", resolvedBy: "U004" });
    expect(chain(planApprovals(inv({ flags: [overridden] }), ctx))).toContain("finance_manager:U003");
    const resolved = flag("PO_OVER_BALANCE", "warn", { status: "resolved", resolvedBy: "U004" });
    expect(chain(planApprovals(inv({ flags: [resolved] }), ctx))).toEqual(["dept_manager:U007"]);
  });

  it.each([
    ["on hold", { status: "on_hold" }],
    ["in an unknown status", { status: "inactive" }],
  ])("holds a vendor that is %s", (_n, patch) => {
    expect(planApprovals(inv(), withVendor(ctx, "V001", patch)).outcome).toBe("hold");
  });

  it("holds an unknown vendor, and keeps invoice text short in the message", () => {
    const name = `Speedy Tlres\n${"x".repeat(500)}`;
    const plan = planApprovals(inv({ vendorId: null, vendorNameRaw: name }), ctx);
    expect(plan.outcome).toBe("hold");
    expect(plan.holdReasons[0]!.message).toMatch(/Speedy Tlres/);
    expect(plan.holdReasons[0]!.message.length).toBeLessThan(200);
    expect(plan.holdReasons[0]!.message).not.toContain("\n");
  });

  it("blocks while a block flag is open; an override needs a name", () => {
    expect(planApprovals(inv({ flags: [flag("DUPLICATE_SUSPECTED", "block")] }), ctx).outcome).toBe("blocked");
    expect(planApprovals(inv({ flags: [flag("DUPLICATE_SUSPECTED", "block", { status: "resolved" })] }), ctx).outcome).toBe("route");
    expect(planApprovals(inv({ flags: [flag("DUPLICATE_SUSPECTED", "block", { status: "overridden" })] }), ctx).outcome).toBe("blocked");
  });

  it("routes a suspected split at the highest combined amount, even if overridden", () => {
    const s1 = flag("SPLIT_INVOICE_SUSPECTED", "warn", { evidence: { combinedCadCents: 1_960_000 } });
    const s2 = flag("SPLIT_INVOICE_SUSPECTED", "warn", { evidence: { combinedCadCents: 5_500_000 }, status: "overridden", resolvedBy: "U004" });
    const plan = planApprovals(inv({ cents: 980_000, flags: [s1, s2] }), ctx);
    expect(plan.routingCadCents).toBe(5_500_000);
    expect(chain(plan)).toEqual(["dept_manager:U007", "finance_manager:U003", "controller_admin:U002"]);
  });

  it("adds a finance review when a split flag has no usable combined total", () => {
    for (const evidence of [{}, { combinedCadCents: "1960000" }, { combinedCadCents: -5 }, { combinedCadCents: 1.5 }]) {
      const plan = planApprovals(inv({ cents: 980_000, flags: [flag("SPLIT_INVOICE_SUSPECTED", "warn", { evidence })] }), ctx);
      expect(plan.steps[1]).toMatchObject({ role: "finance_manager", policyId: null });
    }
  });

  it("routes every historical invoice, with consistent currency, without throwing", () => {
    const plans = historicalInputs().map((i) => planApprovals(i, ctx));
    expect(plans.length).toBeGreaterThan(400);
    for (const p of plans) {
      expect(() => ApprovalPlan.parse(p)).not.toThrow();
      expect(text(p.holdReasons)).not.toMatch(/FX rate|CAD total|× /);
    }
  });

  it("is deterministic", () => {
    const i = inv({ departmentId: "D07", requesterId: "U037", cents: 6_000_000 });
    expect(planApprovals(i, ctx)).toEqual(planApprovals(i, ctx));
  });
});

describe("checkDecision — server-side enforcement", () => {
  const facilities = inv({ departmentId: "D07", requesterId: "U037", cents: 1_800_000 });
  const ref = refFor(facilities);
  const plan0 = planApprovals(facilities, ctx); // U003 (for U012), then U002

  it.each([
    ["requester", "U037", "SELF_APPROVAL"],
    ["auditor", "U006", "ROLE_CANNOT_APPROVE"],
    ["AP clerk", "U004", "ROLE_CANNOT_APPROVE"],
    ["step-2 approver jumping the queue", "U002", "NOT_ASSIGNED"],
    ["unrelated manager", "U008", "NOT_ASSIGNED"],
    ["on-leave original approver", "U012", "USER_INACTIVE"],
    ["terminated user", "U015", "USER_INACTIVE"],
    ["unknown user", "U999", "UNKNOWN_USER"],
    ["empty user id", "", "UNKNOWN_USER"],
  ])("refuses the %s", (_who, actor, expected) => {
    expect(code(checkDecision(plan0, ref, actor, { action: "approve" }, ctx))).toBe(expected);
  });

  it.each([
    ["action in capitals", { action: "APPROVE" }],
    ["no action", {}],
    ["null body", null],
    ["comment that is not text", { action: "reject", comment: 42 }],
    ["comment over 2000 characters", { action: "reject", comment: "x".repeat(2001) }],
  ])("rejects a malformed request: %s", (_n, body) => {
    expect(code(checkDecision(plan0, ref, "U003", body, ctx))).toBe("INVALID_REQUEST");
  });

  it.each([
    ["another invoice's plan", { invoiceId: "OTHER" }, "WRONG_INVOICE"],
    ["an edited invoice (new version)", { invoiceVersion: 2 }, "STALE_PLAN"],
    ["an invoice no longer pending", { status: "Approved" }, "NOT_PENDING"],
  ])("refuses to act on %s", (_n, patch, expected) => {
    expect(code(checkDecision(plan0, { ...ref, ...patch }, "U003", { action: "approve" }, ctx))).toBe(expected);
  });

  it("refuses a corrupt stored plan", () => {
    const dupSeq = { ...plan0, steps: [plan0.steps[0]!, { ...plan0.steps[1]!, seq: 1 }] };
    expect(code(checkDecision(dupSeq, ref, "U003", { action: "approve" }, ctx))).toBe("CORRUPT_PLAN");
    expect(code(checkDecision({ ...plan0, outcome: "yes" } as unknown as ApprovalPlan, ref, "U003", { action: "approve" }, ctx))).toBe("CORRUPT_PLAN");
  });

  it("refuses to act on a held invoice", () => {
    const held = planApprovals(inv({ vendorId: null }), ctx);
    expect(code(checkDecision(held, refFor(inv({ vendorId: null })), "U007", { action: "approve" }, ctx))).toBe("NOT_ROUTED");
  });

  it("walks the happy path and records the delegate", () => {
    const c1 = checkDecision(plan0, ref, "U003", { action: "approve" }, ctx);
    if (!c1.ok) throw new Error(c1.reason);
    const r1 = applyDecision(plan0, c1, new Date("2026-11-03T10:00:00Z"));
    expect(r1).toMatchObject({ event: "stepApproved", isLastStep: false });
    expect(r1.step).toMatchObject({ actedBy: "U003", onBehalfOf: "U012" });

    const plan1 = { ...plan0, steps: r1.steps };
    expect(code(checkDecision(plan1, ref, "U003", { action: "approve" }, ctx))).toBe("ALREADY_SIGNED");
    expect(isAwaiting(plan1, "U002", ref, ctx)).toBe(true);
    expect(() => applyDecision(plan1, c1, new Date())).toThrow(); // double click on stale data

    const c2 = checkDecision(plan1, ref, "U002", { action: "approve", comment: "ok" }, ctx);
    if (!c2.ok) throw new Error(c2.reason);
    const r2 = applyDecision(plan1, c2, new Date("2026-11-03T11:00:00Z"));
    expect(r2.isLastStep).toBe(true);
    expect([...approversOf({ steps: r2.steps })].sort()).toEqual(["U002", "U003", "U012"]);
    expect(code(checkDecision({ ...plan0, steps: r2.steps }, ref, "U001", { action: "approve" }, ctx))).toBe("ALREADY_DECIDED");
  });

  it("treats a signature by your delegate as your signature", () => {
    const c1 = checkDecision(plan0, ref, "U003", { action: "approve" }, ctx);
    if (!c1.ok) throw new Error(c1.reason);
    const plan1 = { ...plan0, steps: applyDecision(plan0, c1, new Date()).steps };
    const liamBack = withUser(ctx, "U012", { status: "active" });
    expect(code(checkDecision(plan1, ref, "U012", { action: "approve" }, liamBack))).toBe("ALREADY_SIGNED");
  });

  it("requires a reason to reject, and a rejection ends the plan", () => {
    expect(code(checkDecision(plan0, ref, "U003", { action: "reject", comment: "  " }, ctx))).toBe("COMMENT_REQUIRED");
    const c = checkDecision(plan0, ref, "U003", { action: "reject", comment: "Goods not received" }, ctx);
    if (!c.ok) throw new Error(c.reason);
    const r = applyDecision(plan0, c, new Date());
    expect(r.event).toBe("stepRejected");
    expect(code(checkDecision({ ...plan0, steps: r.steps }, ref, "U002", { action: "approve" }, ctx))).toBe("ALREADY_DECIDED");
  });

  describe("the org changes after routing (self-healing)", () => {
    const small = inv(); // U007
    const plan = planApprovals(small, ctx);
    const r = refFor(small);

    it("assignee goes on leave → their delegate acts on their behalf", () => {
      const later = withUser(ctx, "U007", { status: "on_leave", delegateId: "U010" });
      expect(checkDecision(plan, r, "U010", { action: "approve" }, later)).toMatchObject({ ok: true, onBehalfOf: "U007" });
      expect(isAwaiting(plan, "U010", r, later)).toBe(true);
      expect(code(checkDecision(plan, r, "U007", { action: "approve" }, later))).toBe("USER_INACTIVE");
    });

    it("assignee is terminated → their manager acts", () => {
      const later = withUser(ctx, "U007", { status: "terminated" });
      expect(checkDecision(plan, r, "U001", { action: "approve" }, later)).toMatchObject({ ok: true, onBehalfOf: null });
    });

    it("absent approver returns → it goes back to them, not the delegate", () => {
      const d07 = inv({ departmentId: "D07", requesterId: "U037" });
      const p = planApprovals(d07, ctx); // U003 for U012
      const back = withUser(ctx, "U012", { status: "active" });
      expect(code(checkDecision(p, refFor(d07), "U003", { action: "approve" }, back))).toBe("NOT_ASSIGNED");
      expect(code(checkDecision(p, refFor(d07), "U012", { action: "approve" }, back))).toBe("ok");
    });

    it("assignee's limit drops below the amount → their manager acts", () => {
      const p = planApprovals(inv({ cents: 800_000 }), ctx);
      const later = withUser(ctx, "U007", { approvalLimitCents: 500_000 });
      expect(code(checkDecision(p, r, "U007", { action: "approve" }, later))).toBe("NOT_ASSIGNED");
      expect(code(checkDecision(p, r, "U001", { action: "approve" }, later))).toBe("ok");
    });

    it("nobody left → a clear 409, not a silent dead end", () => {
      const later = withUser(withUser(ctx, "U007", { status: "terminated" }), "U001", { status: "terminated" });
      expect(code(checkDecision(plan, r, "U008", { action: "approve" }, later))).toBe("NO_ELIGIBLE_APPROVER");
    });

    it("vendor put on hold → cannot approve, can still reject", () => {
      const later = withVendor(ctx, "V001", { status: "on_hold" });
      expect(code(checkDecision(plan, r, "U007", { action: "approve" }, later))).toBe("VENDOR_NOT_PAYABLE");
      expect(code(checkDecision(plan, r, "U007", { action: "reject", comment: "Vendor on hold" }, later))).toBe("ok");
    });

    it("the requester changes on the invoice → the new requester is excluded too", () => {
      expect(code(checkDecision(plan, { ...r, requesterId: "U007" }, "U007", { action: "approve" }, ctx))).toBe("SELF_APPROVAL");
    });
  });

  it("approversOf spans every round, so an approver from a voided round still cannot release", () => {
    const c = checkDecision(plan0, ref, "U003", { action: "approve" }, ctx);
    if (!c.ok) throw new Error(c.reason);
    const round1 = { steps: applyDecision(plan0, c, new Date()).steps };
    const round2 = walk(planApprovals({ ...facilities, invoiceVersion: 2 }, ctx), { ...facilities, invoiceVersion: 2 });
    expect([...approversOf(round1, round2)].sort()).toEqual(["U002", "U003", "U012"]);
  });
});

describe("real-world controls", () => {
  describe("conflicts of interest beyond the requester", () => {
    it("whoever maintains the vendor (onboarded it / changed its bank details) cannot approve its invoices", () => {
      const i = inv({ conflicts: [{ userId: "U007", reason: "changed this vendor's bank details on 2026-10-27" }] });
      const plan = planApprovals(i, ctx);
      expect(plan.steps[0]!.assignedTo).toBe("U001");
      const c = checkDecision(plan, refFor(i), "U007", { action: "approve" }, ctx);
      expect(code(c)).toBe("CONFLICT_OF_INTEREST");
      expect(c.ok ? "" : c.reason).toMatch(/bank details/);
    });

    it("an assistant requesting for their boss does not route the approval to that boss", () => {
      const plan = planApprovals(inv({ requesterId: "U013", conflicts: [{ userId: "U007", reason: "is the person this purchase is for" }] }), ctx);
      expect(plan.steps[0]!.assignedTo).toBe("U001");
    });

    it("whoever overrode a flag gets CONFLICT_OF_INTEREST, the requester gets SELF_APPROVAL", () => {
      const i = inv({ flags: [flag("PRICE_OVER_CONTRACT", "warn", { status: "overridden", resolvedBy: "U007" })] });
      const plan = planApprovals(i, ctx);
      expect(code(checkDecision(plan, refFor(i), "U007", { action: "approve" }, ctx))).toBe("CONFLICT_OF_INTEREST");
      expect(code(checkDecision(plan, refFor(i), "U013", { action: "approve" }, ctx))).toBe("SELF_APPROVAL");
    });
  });

  describe("approvers must acknowledge exceptions", () => {
    const i = inv({
      flags: [
        flag("PRICE_OVER_CONTRACT", "warn", { message: "Unit price $250.00 exceeds contract cap $230.00 (contract C-014)" }),
        flag("VENDOR_ADDRESS_CHANGED", "info"),
        flag("TAX_PROVINCE_MISMATCH", "warn", { status: "resolved" }),
      ],
    });
    const plan = planApprovals(i, ctx);

    it("lists unresolved warnings (not info, not resolved)", () => {
      expect(plan.attention.map((a) => a.code)).toEqual(["PRICE_OVER_CONTRACT"]);
    });

    it("refuses an approval that does not acknowledge them, and says which", () => {
      const c = checkDecision(plan, refFor(i), "U007", { action: "approve" }, ctx);
      expect(code(c)).toBe("FLAGS_NOT_ACKNOWLEDGED");
      expect(c.ok ? "" : c.reason).toMatch(/\$250\.00 exceeds contract cap \$230\.00/);
      expect(code(checkDecision(plan, refFor(i), "U007", { action: "approve", acknowledgedFlags: ["SOMETHING_ELSE"] }, ctx))).toBe("FLAGS_NOT_ACKNOWLEDGED");
      expect(code(checkDecision(plan, refFor(i), "U007", { action: "approve", acknowledgedFlags: "PRICE_OVER_CONTRACT" }, ctx))).toBe("INVALID_REQUEST");
    });

    it("records the acknowledgement on the step; rejecting needs none", () => {
      const c = checkDecision(plan, refFor(i), "U007", { action: "approve", acknowledgedFlags: ["PRICE_OVER_CONTRACT"] }, ctx);
      if (!c.ok) throw new Error(c.reason);
      expect(applyDecision(plan, c, new Date()).step.acknowledgedFlags).toEqual(["PRICE_OVER_CONTRACT"]);
      expect(code(checkDecision(plan, refFor(i), "U007", { action: "reject", comment: "Price over contract" }, ctx))).toBe("ok");
    });

    it("an overridden blocking flag must be acknowledged too", () => {
      const j = inv({ flags: [flag("DUPLICATE_SUSPECTED", "block", { status: "overridden", resolvedBy: "U004" })] });
      expect(planApprovals(j, ctx).attention.map((a) => a.code)).toEqual(["DUPLICATE_SUSPECTED"]);
    });
  });

  it("snapshots the approver's name, role and limit at the moment they act (audit months later)", () => {
    const plan = planApprovals(inv(), ctx);
    const c = checkDecision(plan, refFor(inv()), "U007", { action: "approve" }, ctx);
    if (!c.ok) throw new Error(c.reason);
    const step = applyDecision(plan, c, new Date()).step;
    expect(step.actedAs).toEqual({ fullName: "Dev Malhotra", role: "approver", approvalLimitCents: 1_000_000 });
  });

  it("tells approvers about earlier rejections, and an unchanged resubmission", () => {
    const i = inv();
    const first = planApprovals(i, ctx);
    const c = checkDecision(first, refFor(i), "U007", { action: "reject", comment: "Goods not received" }, ctx);
    if (!c.ok) throw new Error(c.reason);
    const rejected = { ...first, steps: applyDecision(first, c, new Date("2026-11-03T09:00:00Z")).steps };
    expect(text(planApprovals(i, ctx, [rejected]).notes)).toMatch(/Rejected earlier by Dev Malhotra \(U007\) on 2026-11-03: "Goods not received"\. Resubmitted with no change/);
    expect(text(planApprovals({ ...i, invoiceVersion: 2 }, ctx, [rejected]).notes)).toMatch(/Rejected earlier \(version 1\)/);
  });

  describe("budget", () => {
    // D01 Operations budget is $1,800,000.
    it("notes when the invoice takes the department over its annual budget", () => {
      expect(text(planApprovals(inv({ cents: 1_000_000, departmentSpendYtdCadCents: 179_500_000 }), ctx).notes)).toMatch(/Operations to \$1,805,000\.00 of its \$1,800,000\.00 annual budget \(100\.3%\)/);
      expect(text(planApprovals(inv({ departmentSpendYtdCadCents: 100_000_000 }), ctx).notes)).not.toMatch(/budget/);
      expect(text(planApprovals(inv({ cents: -1_000_000, departmentSpendYtdCadCents: 200_000_000 }), ctx).notes)).not.toMatch(/budget/);
    });

    it("an admin can make an over-budget invoice need the finance manager", () => {
      const rule = ApprovalPolicy.parse({
        id: "X01", version: 1, active: true, ruleType: "approval", priority: 0, description: "Over budget",
        conditions: { kind: "department_over_budget" }, steps: { type: "add_step", role: "finance_manager" },
      });
      const c = { ...ctx, policies: [...ctx.policies, rule] };
      expect(chain(planApprovals(inv({ departmentSpendYtdCadCents: 179_900_000 }), c))).toEqual(["dept_manager:U007", "finance_manager:U003"]);
    });
  });

  describe("edits after approval (approved amount vs paid amount)", () => {
    const original = inv({ cents: 300_000 });
    const approved = walk(planApprovals(original, ctx), original);
    const edit = (patch: Partial<ApprovalInput> & { cents?: number }) => reapprovalReasons(approved, inv({ cents: 300_000, ...patch }), ctx);

    it("keeps approvals for no change, a decrease, or an increase within tolerance (lesser of 2% / $100)", () => {
      expect(edit({})).toEqual([]);
      expect(edit({ cents: 250_000 })).toEqual([]);
      expect(edit({ cents: 306_000 })).toEqual([]); // +$60 = 2% of $3,000
    });

    it("voids them for a bigger increase, with the numbers", () => {
      expect(text(edit({ cents: 306_001 }))).toMatch(/went up by CAD 60\.01/);
      const big = inv({ cents: 6_000_000 });
      const approvedBig = walk(planApprovals(big, ctx), big);
      expect(text(reapprovalReasons(approvedBig, inv({ cents: 6_010_001 }), ctx))).toMatch(/more than the \$100\.00 allowed/);
    });

    it.each([
      ["payee", { vendorId: "V002" }, /payee changed/],
      ["purchase order", { poId: "PO-2026-0001" }, /purchase order changed/],
      ["department", { departmentId: "D05" }, /department changed/],
      ["requester", { requesterId: "U014" }, /requester changed/],
      ["currency", { currency: "USD", totalCents: 300_000, fxRateToCad: 1.37, totalCadCents: 411_000 }, /currency changed/],
      ["invoice → credit note", { cents: -300_000 }, /to a credit note/],
    ])("voids them when the %s changes", (_n, patch, why) => {
      expect(text(edit(patch))).toMatch(why);
    });

    it("voids them when a small edit crosses into a higher approval tier", () => {
      const near = inv({ cents: 995_000 });
      const approvedNear = walk(planApprovals(near, ctx), near);
      const reasons = reapprovalReasons(approvedNear, inv({ cents: 1_005_000 }), ctx); // +$100: within tolerance
      expect(text(reasons)).not.toMatch(/went up/);
      expect(text(reasons)).toMatch(/now also needs a finance_manager approval/);
    });

    it("voids them when a new exception appears, or an approver is no longer independent", () => {
      expect(text(edit({ flags: [flag("PRICE_OVER_CONTRACT", "warn")] }))).toMatch(/New exception .*PRICE_OVER_CONTRACT/);
      expect(text(edit({ conflicts: [{ userId: "U007", reason: "is the person this purchase is for" }] }))).toMatch(/Dev Malhotra \(U007\) approved it but now is the person/);
    });

    it("voids them when the edited invoice would no longer route", () => {
      expect(text(reapprovalReasons(approved, inv({ cents: 300_000 }), withVendor(ctx, "V001", { status: "on_hold" })))).toMatch(/would not route/);
    });

    it("credit notes: less credit needs re-approval, more credit does not", () => {
      const credit = inv({ cents: -300_000 });
      const approvedCredit = walk(planApprovals(credit, ctx), credit);
      expect(text(reapprovalReasons(approvedCredit, inv({ cents: -200_000 }), ctx))).toMatch(/went up/);
      expect(reapprovalReasons(approvedCredit, inv({ cents: -400_000 }), ctx)).toEqual([]);
    });
  });

  describe("aging: approvals that sit until the due date or discount passes", () => {
    // ctx.asOf = 2026-11-02, a Monday, so plans are routed then.
    const i = inv({ cents: 1_800_000 }); // U007 then U003
    const plan = planApprovals(i, ctx);
    const at = (iso: string) => new Date(`${iso}T12:00:00Z`);

    it("counts business days, skipping weekends", () => {
      expect(businessDaysBetween(at("2026-11-06"), at("2026-11-09"))).toBe(1); // Fri → Mon
      expect(businessDaysBetween(at("2026-11-02"), at("2026-11-09"))).toBe(5);
      expect(businessDaysBetween(at("2026-11-02"), at("2026-11-02"))).toBe(0);
      expect(businessDaysBetween(at("2026-11-09"), at("2026-11-02"))).toBe(0);
      expect(businessDaysBetween(at("2026-11-02"), at("2026-11-30"))).toBe(20);
    });

    it("on time → remind → escalate to the approver's manager", () => {
      expect(approvalAging(plan, at("2026-11-03"), ctx)?.level).toBe("on_time");
      expect(approvalAging(plan, at("2026-11-04"), ctx)).toMatchObject({ level: "remind", notify: ["U007"] });
      expect(approvalAging(plan, at("2026-11-09"), ctx)).toMatchObject({ level: "escalate", notify: ["U007", "U001"], businessDaysWaiting: 5 });
    });

    it("escalates on day one if the invoice is due soon or overdue; reminds before a discount lapses", () => {
      expect(approvalAging(plan, at("2026-11-02"), ctx, { dueDate: "2026-11-04" })?.level).toBe("escalate");
      expect(approvalAging(plan, at("2026-11-02"), ctx, { dueDate: "2026-10-30" })?.message).toMatch(/3 day\(s\) past due/);
      expect(approvalAging(plan, at("2026-11-02"), ctx, { dueDate: "2026-12-30", discountDeadline: "2026-11-04" })).toMatchObject({ level: "remind" });
      expect(approvalAging(plan, at("2026-11-02"), ctx, { dueDate: "not a date" })?.daysToDue).toBeNull();
    });

    it("a later step waits from when the previous one was decided", () => {
      const c = checkDecision(plan, refFor(i), "U007", { action: "approve" }, ctx);
      if (!c.ok) throw new Error(c.reason);
      const p1 = { ...plan, steps: applyDecision(plan, c, at("2026-11-06")).steps };
      expect(approvalAging(p1, at("2026-11-09"), ctx)).toMatchObject({ seq: 2, waitingOn: "U003", businessDaysWaiting: 1 });
    });

    it("nothing to age on a held or finished plan", () => {
      expect(approvalAging(planApprovals(inv({ vendorId: null }), ctx), at("2026-11-20"), ctx)).toBeNull();
      expect(approvalAging(walk(plan, i), at("2026-11-20"), ctx)).toBeNull();
    });
  });
});

describe("invariants", () => {
  it("every routed historical invoice can be approved end to end by the people it waits on", () => {
    let routed = 0;
    for (const i of historicalInputs()) {
      const plan = planApprovals(i, ctx);
      if (plan.outcome !== "route") continue;
      routed++;
      expect(waitingOn(plan, refFor(i), ctx)?.assignee).toBe(plan.steps[0]!.assignedTo);
      const done = walk(plan, i);
      const signers = done.steps.map((s) => s.actedBy);
      expect(new Set(signers).size).toBe(signers.length);
      expect(signers).not.toContain(i.requesterId);
    }
    expect(routed).toBeGreaterThan(350);
  });

  it("holds under random org chaos: no crash, no self-approval, no double signature, enough authority", () => {
    // Deterministic PRNG so a failure reproduces.
    let seed = 20261121;
    const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!; // non-empty lists only
    const userIds = [...ctx.users.keys()];
    const deptIds = [...ctx.departments.keys()];
    const vendorIds = [...ctx.vendors.keys()];
    const statuses = ["active", "active", "active", "on_leave", "terminated", "suspended"];
    let routedCount = 0;

    for (let n = 0; n < 3000; n++) {
      let c = ctx;
      for (let k = 0; k < 3; k++) {
        c = withUser(c, pick(userIds), {
          status: pick(statuses),
          delegateId: rand() < 0.7 ? pick(userIds) : null,
          ...(rand() < 0.1 ? { managerId: pick(userIds) } : {}),
        });
      }
      const cents = Math.floor(rand() * 40_000_000) * (rand() < 0.05 ? -1 : 1);
      const i = inv({
        invoiceId: `F-${n}`,
        departmentId: pick(deptIds),
        requesterId: pick(userIds),
        submittedBy: rand() < 0.3 ? pick(userIds) : null,
        vendorId: pick(vendorIds),
        poId: rand() < 0.5 ? "PO-1" : null,
        cents,
        conflicts: rand() < 0.2 ? [{ userId: pick(userIds), reason: "maintains this vendor in the vendor master" }] : [],
        flags: rand() < 0.2 ? [flag("PRICE_OVER_CONTRACT", "warn")] : [],
      });
      const plan = planApprovals(i, c);
      expect(() => ApprovalPlan.parse(plan)).not.toThrow();
      if (plan.outcome !== "route") continue;
      routedCount++;

      const excluded = new Set(plan.excludedApprovers.map((e) => e.userId));
      const people = plan.steps.flatMap((s) => [s.assignedTo, ...(s.onBehalfOf ? [s.onBehalfOf] : [])]);
      expect(new Set(people).size).toBe(people.length); // nobody twice, not even via a delegate
      for (const s of plan.steps) {
        expect(excluded.has(s.assignedTo)).toBe(false);
        if (s.onBehalfOf) expect(excluded.has(s.onBehalfOf)).toBe(false);
        expect(c.users.get(s.assignedTo)?.status).toBe("active");
      }
      const done = walk(plan, i, c);
      const signed = done.steps.map((s) => s.actedBy!);
      expect(signed).not.toContain(i.requesterId);
      expect(Math.max(...signed.map((id) => c.users.get(id)!.approvalLimitCents))).toBeGreaterThanOrEqual(plan.routingCadCents);
    }
    expect(routedCount).toBeGreaterThan(500);
  });
});
