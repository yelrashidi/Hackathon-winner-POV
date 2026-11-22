import { describe, expect, it } from "vitest";
import { ApprovalInput, type ApprovalPlan } from "@/contracts/approvals";
import {
  InMemoryApprovalStore,
  PENDING_APPROVAL_STATUS,
  applyDecision,
  approversOf,
  checkDecision,
  getApprovalPlans,
  getCurrentApprovalPlan,
  planApprovals,
  saveApprovalPlan,
  saveDecision,
  waitingOn,
  type InvoiceRef,
} from "@/server/features/approvals";
import { loadContext as loadApprovalsContext } from "@/server/features/approvals/__tests__/dataset";
import { codeLine, lineDepartments, suggestCoding, type CodingActor } from "@/server/features/coding";
import { loadCodingContext } from "@/server/features/coding/__tests__/dataset";
import { loadIncomingFixtures, validateBatch } from "@/server/features/validation/dataset/batch";
import { loadDatasetContext } from "@/server/features/validation/dataset/load-context";

/**
 * Do the steps work TOGETHER? The 56 incoming invoices go through the hand-offs the analysis
 * pass and the approval flow will make, with no foundation code yet:
 *
 *   validation (4) → vendor, CAD total, flags
 *   coding (3)     → same vendor, lines confirmed by a clerk through the coding gate, departments
 *   approvals (6)  → ApprovalInput built from 4 + 3, routed, every step approved through the store
 *   payments (7)   → reads approvers (P11) and the approved basis the way payments' deps.ts does
 *
 * Only invariants are asserted (no counts that a teammate's rule change would legitimately move):
 * a failure here means two features disagree about a shape, a number or a person.
 * Intake does not capture a requester yet, so the test plays the clerk: an employee of the
 * department coding suggests.
 */

const clerk: CodingActor = { id: "U004", role: "ap_clerk", status: "active" };
const CURRENCY_HOLD = /carries an FX rate|differs from the invoice total|FX rate of exactly 1|CAD, but the invoice says/;

interface Outcome {
  file: string;
  stage: "no department" | "no requester" | "no CAD total" | ApprovalPlan["outcome"];
  approvedEndToEnd: boolean;
  problems: string[];
}

async function runPipeline(): Promise<Outcome[]> {
  const fixtures = loadIncomingFixtures();
  const validated = validateBatch(fixtures.map((f) => f.fixture.input), loadDatasetContext());
  const codingCtx = loadCodingContext();
  const approvalsCtx = loadApprovalsContext();
  const store = new InMemoryApprovalStore();
  const outcomes: Outcome[] = [];

  for (const [i, { file, fixture }] of fixtures.entries()) {
    const input = fixture.input;
    const v = validated[i]!;
    const problems: string[] = [];
    const done = (stage: Outcome["stage"], approvedEndToEnd = false) => outcomes.push({ file, stage, approvedEndToEnd, problems });

    // 4 → 3: one vendor for everyone.
    const coding = suggestCoding(input, v.vendorId, codingCtx);
    if (coding.vendorId !== v.vendorId) problems.push(`coding vendor ${coding.vendorId} ≠ validation vendor ${v.vendorId}`);

    // A clerk confirms every line that has a suggestion.
    let lines = coding.lines;
    for (const l of coding.lines) {
      if (!l.glAccount || !l.departmentId) continue;
      const r = codeLine(lines, l.lineNo, { glAccount: l.glAccount, departmentId: l.departmentId, note: "checked" }, clerk, codingCtx, new Date("2026-11-03T09:00:00Z"), {
        invoiceId: coding.invoiceId, vendorId: coding.vendorId, invoiceNumber: input.invoiceNumber ?? null, invoiceDate: input.invoiceDate ?? null, departmentId: null, currency: input.currency ?? null,
      });
      if (r.ok) lines = r.lines;
      else problems.push(`coding gate refused the clerk on line ${l.lineNo}: ${r.code}`);
    }

    const departmentId = coding.invoiceDepartment.value;
    if (!departmentId) { done("no department"); continue; }
    const requester = [...approvalsCtx.users.values()].find((u) => u.departmentId === departmentId && u.role === "employee" && u.status === "active");
    if (!requester) { done("no requester"); continue; }
    if (v.totalCadCents === null || input.totalCents == null || !input.currency) { done("no CAD total"); continue; }

    // 4 + 3 → 6: the approval input, exactly as the analysis pass would build it.
    const draft = {
      invoiceId: input.invoiceId, invoiceVersion: 1, vendorId: v.vendorId, vendorNameRaw: input.vendor?.nameRaw ?? "",
      departmentId, requesterId: requester.id, submittedBy: clerk.id, poId: input.poNumber ?? null,
      currency: input.currency, totalCents: input.totalCents, fxRateToCad: v.fxRate ? Number(v.fxRate) : 1, totalCadCents: v.totalCadCents,
      lineDepartmentIds: lineDepartments(lines), flags: v.flags,
    };
    const parsed = ApprovalInput.safeParse(draft);
    if (!parsed.success) {
      problems.push(`approvals rejected the input: ${parsed.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`);
      done("hold");
      continue;
    }
    const plan = planApprovals(draft, approvalsCtx);
    const currencyHold = plan.holdReasons.find((h) => CURRENCY_HOLD.test(h.message));
    if (currencyHold) problems.push(`validation's CAD total and approvals' re-check disagree: ${currencyHold.message}`);
    if (plan.outcome !== "route") { done(plan.outcome); continue; }

    // 6: every step approved by whoever it is waiting on, through the store.
    await saveApprovalPlan(plan, { store });
    const ref: InvoiceRef = { invoiceId: plan.invoiceId, invoiceVersion: 1, status: PENDING_APPROVAL_STATUS, requesterId: requester.id, submittedBy: clerk.id, vendorId: v.vendorId };
    let finished = false;
    for (let guard = 0; guard < 8 && !finished; guard++) {
      const current = (await getCurrentApprovalPlan(plan.invoiceId, { invoiceVersion: 1, store }))!;
      const who = waitingOn(current, ref, approvalsCtx)?.assignee;
      if (!who) { problems.push("approval stalled: nobody to act"); break; }
      const check = checkDecision(current, ref, who, { action: "approve", acknowledgedFlags: current.attention.map((a) => a.code) }, approvalsCtx);
      if (!check.ok) { problems.push(`${who} refused: ${check.code}`); break; }
      const result = applyDecision(current, check, new Date("2026-11-04T10:00:00Z"));
      await saveDecision(plan.invoiceId, 1, result, { store });
      finished = result.isLastStep;
    }

    // 6 → 7: what payments reads (deps.ts getApprovalFacts).
    const all = await getApprovalPlans(plan.invoiceId, { store });
    const current = await getCurrentApprovalPlan(plan.invoiceId, { invoiceVersion: 1, store });
    const approvers = approversOf(...all);
    if (!current) problems.push("payments would find no current plan");
    else {
      if (current.basis.currency !== input.currency || current.basis.totalCents !== input.totalCents || current.basis.vendorId !== v.vendorId) {
        problems.push("the approved basis differs from the invoice");
      }
      if (approvers.size === 0) problems.push("payments would see no approvers");
      if (approvers.has(requester.id)) problems.push("the requester is among the approvers");
    }
    done("route", finished);
  }
  return outcomes;
}

describe("the steps work together on the 56 incoming invoices", async () => {
  const outcomes = await runPipeline();
  const tally = outcomes.reduce<Record<string, number>>((t, o) => ({ ...t, [o.stage]: (t[o.stage] ?? 0) + 1 }), {});

  it("every invoice reaches a definite outcome", () => {
    console.log(`pipeline outcomes: ${JSON.stringify(tally)}`);
    expect(outcomes).toHaveLength(56);
  });

  it("no two features disagree about a shape, a number or a person", () => {
    expect(outcomes.flatMap((o) => o.problems.map((p) => `${o.file}: ${p}`))).toEqual([]);
  });

  it("every routed invoice can be approved to the end, and payments sees it", () => {
    const routed = outcomes.filter((o) => o.stage === "route");
    expect(routed.length).toBeGreaterThan(0);
    expect(routed.filter((o) => !o.approvedEndToEnd).map((o) => o.file)).toEqual([]);
  });
});
