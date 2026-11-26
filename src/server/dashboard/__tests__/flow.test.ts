import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Actor, ActorRole } from "@/contracts/actor";
import { Forbidden } from "@/server/core/authorize";
import type { Db } from "@/server/db/client";
import { createSeededDb } from "@/server/db/__tests__/helpers";
import { invoices, users } from "@/server/db/schema";
import { loadDatasetInbox } from "@/server/demo/load-inbox";
import { sendCleanBillsToApproval } from "@/server/demo/scenario";
import { setEftRail, SimulatedEft } from "@/server/features/payments";
import { acceptConfidentLines, codeInvoiceLine, decideApproval, editInvoice, paymentsDb, setUserAvailability, submitForApproval, updatePolicy } from "@/server/pipeline";
import { getApproval, listApprovals } from "../approvals";
import { auditDetail, auditList, PAST_STATUSES } from "../audit";
import { getCheck, listChecks } from "../checks";
import { getVendor, listInbox, listVendors, recentActivity } from "../records";

/**
 * The redesigned dashboard, end to end, through the same functions its pages and buttons call — on
 * the demo database (seed + the AP inbox through intake). One clean incoming bill goes:
 *   Checks (clerk) → Approvals (manager → Finance Manager if routed) → Payments (clerk schedules,
 *   Finance Manager or Admin releases, bank settles) → Audit trail (auditor sees it as past).
 * Plus the role rules the screens rely on. Nothing names a dataset invoice: it is picked by what it is.
 */

let db: Db;
let client: PGlite;
const q = async <T>(sql: string) => (await client.query<T>(sql)).rows;
const as = async (userId: string): Promise<Actor> => {
  const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
  return { userId, role: u!.role as ActorRole };
};
const first = async (role: string) => as((await q<{ id: string }>(`SELECT id FROM users WHERE role = '${role}' AND status = 'active' ORDER BY id LIMIT 1`))[0]!.id);

let CLERK: Actor, FM: Actor, ADMIN: Actor, AUDITOR: Actor;

beforeAll(async () => {
  ({ db, client } = await createSeededDb());
  await loadDatasetInbox(db);
  setEftRail(new SimulatedEft());
  [CLERK, FM, ADMIN, AUDITOR] = await Promise.all([first("ap_clerk"), first("finance_manager"), first("controller_admin"), first("auditor")]);
}, 180_000);

describe("the dashboard, role by role", () => {
  it("inbox: every email is listed with intake's verdict, and bills link to their invoices", async () => {
    const rows = await listInbox(CLERK, { db });
    expect(rows.length).toBeGreaterThan(50);
    expect(rows.every((r) => r.decision !== "unclassified")).toBe(true);
    expect(rows.filter((r) => r.decision === "invoice").every((r) => r.invoices.length > 0)).toBe(true);
    expect(rows.filter((r) => r.decision !== "invoice").every((r) => r.reason)).toBe(true);
    await expect(listInbox(AUDITOR, { db })).rejects.toBeInstanceOf(Forbidden);
  });

  it("checks: every incoming bill is queued with a reason, most urgent first; the auditor has no checks", async () => {
    const rows = await listChecks(CLERK, { db });
    const [{ n }] = (await q<{ n: number }>("SELECT count(*)::int AS n FROM invoices WHERE status IN ('ManualEntry','InReview','OnHold')")) as [{ n: number }];
    expect(rows).toHaveLength(n);
    expect(rows.every((r) => r.reasons.length > 0)).toBe(true);
    // Nobody set a requester at intake, so every bill asks for one.
    expect(rows.every((r) => r.reasons.some((x) => x.kind === "requester"))).toBe(true);
    await expect(listChecks(AUDITOR, { db })).rejects.toBeInstanceOf(Forbidden);
    // Managers and the Finance Manager can do the clerk's checks too (dashboard plan).
    const manager = await as("U007");
    await expect(listChecks(manager, { db })).resolves.toHaveLength(n);
  });

  it("one bill goes all the way: checks → approvals → payment → audit trail", async () => {
    // A clean, CAD, modest bill with a matched vendor and a coding department.
    const rows = await listChecks(CLERK, { db });
    const pick = rows.find((r) => r.flags.block === 0 && r.flags.warn === 0 && r.vendorId && r.currency === "CAD" && (r.totalCadCents ?? 0) > 0 && (r.totalCadCents ?? 0) < 1_000_000 && r.departmentName);
    expect(pick, "a clean bill under $10k").toBeTruthy();
    const id = pick!.invoiceId;

    // Checks: set the requester (an employee of the department), confirm the coding.
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, id));
    const [requester] = await q<{ id: string }>(`SELECT id FROM users WHERE role = 'employee' AND status = 'active' AND department_id = '${inv!.departmentId}' ORDER BY id LIMIT 1`);
    await editInvoice(CLERK, id, { requesterId: requester!.id }, { db, reason: "Asked by the dispatcher" });
    await acceptConfidentLines(CLERK, id, { db });
    let check = (await getCheck(CLERK, id, { db }))!;
    for (const l of check.lines.filter((x) => x.source === "suggested")) {
      await codeInvoiceLine(CLERK, id, l.lineNo, { glAccount: l.glAccount ?? "6900", departmentId: l.departmentId ?? inv!.departmentId, note: "Checked against the PDF" }, { db });
    }
    check = (await getCheck(CLERK, id, { db }))!;
    expect(check.lines.every((l) => l.source !== "suggested")).toBe(true);
    // The preview is exactly what submit does.
    expect(check.preview?.outcome, JSON.stringify({ hold: check.preview?.holdReasons, flags: check.flags.filter((f) => f.status === "open").map((f) => f.code) })).toBe("route");
    const plan = await submitForApproval(CLERK, id, { db });
    expect(plan.steps.map((s) => s.assignedTo)).toEqual(check.preview!.steps.map((s) => s.assignedTo));
    expect(plan.excludedApprovers.map((e) => e.userId)).toContain(CLERK.userId);

    // Approvals: each step appears in exactly one person's "waiting on you", and they approve it.
    for (let i = 0; i < 5; i++) {
      const all = await listApprovals(FM, { db });
      const row = all.find((r) => r.invoiceId === id);
      if (!row) break;
      const approver = await as(row.waitingOn!.userId);
      const mine = await listApprovals(approver, { db });
      expect(mine.find((r) => r.invoiceId === id)?.mine).toBe(true);
      const detail = (await getApproval(approver, id, { db }))!;
      expect(detail.you).toMatchObject({ canAct: true });
      // The clerk who submitted it is not the approver, and cannot act.
      const clerkView = await getApproval(CLERK, id, { db });
      expect(clerkView?.you).toBeNull();
      await decideApproval(approver, id, { action: "approve", comment: "OK", acknowledgedFlags: detail.plan!.attention.map((a) => a.code) }, { db });
    }
    expect((await db.select({ s: invoices.status }).from(invoices).where(eq(invoices.id, id)))[0]!.s).toBe("Approved");

    // Payments: the clerk schedules it; someone the rules allow releases it; the bank settles it.
    const awaiting = await paymentsDb.list(CLERK.userId, { db });
    expect(awaiting.awaitingPayment.map((i) => i.invoiceId)).toContain(id);
    const s = await paymentsDb.schedule(CLERK, { invoiceId: id }, { db });
    expect(s.ok, JSON.stringify(s)).toBe(true);
    const [releasers] = await paymentsDb.eligibleReleasers([id], { db });
    const approvers = (await getApproval(FM, id, { db }))!.plan!.steps.map((x) => x.actedBy);
    expect(releasers!.some((p) => approvers.includes(p.userId))).toBe(false);
    const r = await paymentsDb.release(await as(releasers![0]!.userId), { paymentId: (s as { value: { paymentId: string } }).value.paymentId }, { db });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    await paymentsDb.settle(CLERK, { paymentId: (s as { value: { paymentId: string } }).value.paymentId, outcome: "SETTLED" }, { db });

    // Audit: now past, so the auditor sees it, with the whole story.
    const list = await auditList(AUDITOR, { search: id }, { db });
    expect(list.rows.map((x) => x.invoiceId)).toContain(id);
    const trail = (await auditDetail(AUDITOR, id, { db }))!;
    expect(trail.invoice.status).toBe("Paid");
    const actions = trail.timeline.map((e) => e.action);
    for (const a of ["invoice.created", "invoice.validated", "invoice.coding_suggested", "invoice.line_coded", "approval.routed", "approval.decided", "payment.scheduled", "payment.released", "payment.settled"]) expect(actions).toContain(a);
    expect(trail.controls.find((c) => c.id === "APPROVER_NOT_REQUESTER")?.result).toBe("pass");
  });

  it("only the auditor (and the admin) read the audit trail; the auditor sees every invoice — in progress too", async () => {
    const all = await auditList(AUDITOR, { pageSize: 200 }, { db });
    expect(all.rows.some((r) => !PAST_STATUSES.includes(r.status))).toBe(true);
    await expect(auditList(CLERK, { pageSize: 200 }, { db })).rejects.toBeInstanceOf(Forbidden);
    const [inReview] = await q<{ id: string }>("SELECT id FROM invoices WHERE status = 'InReview' LIMIT 1");
    expect(await auditDetail(AUDITOR, inReview!.id, { db })).toMatchObject({ invoice: { invoiceId: inReview!.id } });
    await expect(auditDetail(CLERK, inReview!.id, { db })).rejects.toBeInstanceOf(Forbidden);
  });

  it("the auditor reads the vendor master (read-only)", async () => {
    await expect(listVendors(AUDITOR, { db })).resolves.not.toHaveLength(0);
    await expect(getVendor(AUDITOR, "V001", { db })).resolves.toMatchObject({ vendor: { id: "V001" } });
  });

  it("recent activity: the auditor sees everyone's actions, anyone else only their own", async () => {
    const all = await recentActivity(AUDITOR, { db, limit: 50 });
    const mine = await recentActivity(CLERK, { db, limit: 50 });
    expect(mine.every((e) => e.actor?.userId === CLERK.userId)).toBe(true);
    expect(all.length).toBeGreaterThanOrEqual(mine.length);
  });

  it("delegation: the Admin puts an approver on leave and the delegate's queue shows it, on behalf of", async () => {
    // A bill waiting on a department manager.
    const rows = await listChecks(CLERK, { db });
    const pick = rows.find((r) => r.status === "InReview" && r.flags.block === 0 && r.flags.warn === 0 && r.vendorId && r.currency === "CAD" && (r.totalCadCents ?? 0) > 0 && (r.totalCadCents ?? 0) < 1_000_000 && r.departmentName);
    if (!pick) return;
    const id = pick.invoiceId;
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, id));
    const [requester] = await q<{ id: string }>(`SELECT id FROM users WHERE role = 'employee' AND status = 'active' AND department_id = '${inv!.departmentId}' ORDER BY id LIMIT 1`);
    await editInvoice(CLERK, id, { requesterId: requester!.id }, { db });
    await acceptConfidentLines(CLERK, id, { db, minimum: "medium" });
    for (const l of (await getCheck(CLERK, id, { db }))!.lines.filter((x) => x.source === "suggested")) {
      await codeInvoiceLine(CLERK, id, l.lineNo, { glAccount: l.glAccount ?? "6900", departmentId: l.departmentId ?? inv!.departmentId, note: "ok" }, { db });
    }
    const plan = await submitForApproval(CLERK, id, { db });
    if (plan.outcome !== "route") return;
    const manager = plan.steps[0]!.assignedTo;
    const [other] = await q<{ id: string }>(`SELECT id FROM users WHERE role IN ('approver','finance_manager','controller_admin') AND status = 'active' AND id <> '${manager}' AND id <> '${requester!.id}' ORDER BY id LIMIT 1`);
    const delegate = await as(other!.id);
    await setUserAvailability(ADMIN, manager, { status: "on_leave", delegateId: delegate.userId, note: "Vacation this week" }, { db });
    const queue = await listApprovals(delegate, { db });
    const row = queue.find((r) => r.invoiceId === id);
    expect(row?.mine).toBe(true);
    expect(row?.onBehalfOf?.userId).toBe(manager);
    await expect(setUserAvailability(CLERK, manager, { status: "active", note: "x" }, { db })).rejects.toBeInstanceOf(Forbidden);
  });

  it("policy edits are new versions, Admin only, audited", async () => {
    const p = await updatePolicy(ADMIN, "P01", { amountCadCents: 1_200_000, note: "Raise the department limit to $12,000" }, { db });
    expect(p.version).toBe(2);
    await expect(updatePolicy(FM, "P01", { active: false, note: "x" }, { db })).rejects.toBeInstanceOf(Forbidden);
    const [ev] = await q<{ reason: string }>("SELECT reason FROM audit_events WHERE action = 'policy.edited' ORDER BY id DESC LIMIT 1");
    expect(ev!.reason).toMatch(/12,000/);
    // The description says the new threshold, not the one the policy file started with; the notes stay.
    expect(p.description).toMatch(/^Invoice total up to \$12,000 CAD/);
    expect(p.description).not.toMatch(/10,000/);
    // A non-amount change keeps the (now correct) amount; P09's release threshold is restated the same way.
    expect((await updatePolicy(ADMIN, "P01", { active: false, note: "Pause it" }, { db })).description).toMatch(/\$12,000/);
    await updatePolicy(ADMIN, "P01", { active: true, note: "Back on" }, { db });
    expect((await updatePolicy(ADMIN, "P09", { amountCadCents: 15_000_050, note: "Raise the release limit" }, { db })).description).toMatch(/^Payment up to \$150,000\.50 CAD/);
  });

  it("vendors: the vendor master lists bank status; the Admin and finance staff see it, managers don't", async () => {
    const rows = await listVendors(FM, { db });
    expect(rows.length).toBeGreaterThan(40);
    expect(rows.some((r) => r.bank)).toBe(true);
    await expect(listVendors(await as("U007"), { db })).rejects.toBeInstanceOf(Forbidden);
  });

  it("demo shortcut: sends clean bills to approval as a real clerk, through the same services", async () => {
    const sent = await sendCleanBillsToApproval(2, { db });
    expect(sent.length).toBeGreaterThan(0);
    const [ev] = await q<{ actor_role: string }>(`SELECT actor_role FROM audit_events WHERE invoice_id = '${sent[0]}' AND action = 'approval.routed'`);
    expect(ev!.actor_role).toBe("ap_clerk");
    const all = await listApprovals(FM, { db });
    for (const id of sent) expect(all.map((r) => r.invoiceId)).toContain(id);
  });
});
