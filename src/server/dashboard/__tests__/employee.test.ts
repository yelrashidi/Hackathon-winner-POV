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
import { getInvoiceRecord, listInvoiceRecords, plainStatus } from "@/server/features/invoices";
import { approveVendor, holdVendor, requestBankChange } from "@/server/features/vendors";
import { setEftRail, SimulatedEft } from "@/server/features/payments";
import { acceptConfidentLines, codeInvoiceLine, decideApproval, editInvoice, paymentsDb, submitForApproval } from "@/server/pipeline";
import { appRoleOf, APP_ROLES } from "@/server/session/roles";
import { demoRoster } from "@/server/session/roster";
import { canSee, sectionsFor, SECTIONS } from "../../../../app/_lib/nav";
import { getApproval, listApprovals } from "../approvals";
import { getCheck, listChecks, REQUESTER_ROLES, reviewOptions } from "../checks";

/**
 * The sixth role (docs/brief.md: six roles). The Employee is read-only: "My bills" — the bills they
 * requested and where each one is. The AP Clerk records them as the requester on Checks; the bill then
 * routes to their department's manager. Every mutating action refuses them on the server.
 * Nothing names a dataset person or invoice: they are picked by rule, like the roster does.
 */

let db: Db;
let client: PGlite;
const q = async <T>(sql: string) => (await client.query<T>(sql)).rows;
const as = (userId: string, role: string): Actor => ({ userId, role: role as ActorRole });

let EMP: Actor, CLERK: Actor, MANAGER: Actor, FM: Actor;
let empDept = "";
let managerName = "";

/** Refused on the server: a Forbidden, or a payments result that says no. */
async function refused(call: () => Promise<unknown>): Promise<boolean> {
  try {
    const r = (await call()) as { ok?: boolean } | undefined;
    return r?.ok === false;
  } catch (err) {
    return err instanceof Forbidden || (err instanceof Error && /not allowed|cannot|forbidden|may not/i.test(err.message));
  }
}

beforeAll(async () => {
  ({ db, client } = await createSeededDb());
  await loadDatasetInbox(db);
  setEftRail(new SimulatedEft());
  const cast = await demoRoster(db);
  const pick = (r: string) => cast.find((c) => c.role === r)!.user;
  EMP = as(pick("employee").id, "employee");
  CLERK = as(pick("clerk").id, "ap_clerk");
  MANAGER = as(pick("manager").id, "approver");
  FM = as(pick("finance").id, "finance_manager");
  empDept = pick("employee").departmentId;
  managerName = pick("manager").fullName;
}, 180_000);

describe("the employee role", () => {
  it("is the sixth role: six people in the cast, the employee picked by rule (reports to the cast's manager)", async () => {
    const cast = await demoRoster(db);
    expect(cast.map((c) => c.role)).toEqual(APP_ROLES.map((r) => r.key));
    expect(cast).toHaveLength(6);
    const emp = cast.find((c) => c.role === "employee")!.user;
    const mgr = cast.find((c) => c.role === "manager")!.user;
    expect(emp.role).toBe("employee");
    expect(emp.status).toBe("active");
    expect(emp.managerId).toBe(mgr.id);
    // The FIRST such employee (by id).
    const [first] = await q<{ id: string }>(`SELECT id FROM users WHERE role = 'employee' AND status = 'active' AND manager_id = '${mgr.id}' ORDER BY id LIMIT 1`);
    expect(emp.id).toBe(first!.id);
    expect(appRoleOf("employee")).toBe("employee");
  });

  it("sees only Home and Invoices (labelled My bills); every other screen is not for their role", () => {
    expect(sectionsFor("employee").map((s) => s.key)).toEqual(["home", "invoices"]);
    expect(SECTIONS.find((s) => s.key === "invoices")!.labelFor?.employee).toBe("My bills");
    for (const s of SECTIONS.filter((x) => !["home", "invoices"].includes(x.key))) expect(canSee("employee", s.key), s.key).toBe(false);
  });

  it("My bills: exactly the invoices they requested, newest first, each in plain words", async () => {
    const list = await listInvoiceRecords(EMP, { pageSize: 200 }, { db });
    expect(list.scope).toEqual({ kind: "own", userId: EMP.userId });
    const own = await q<{ id: string; status: string }>(`SELECT id, status FROM invoices WHERE requester_id = '${EMP.userId}' ORDER BY invoice_date DESC, id DESC`);
    expect(own.length).toBeGreaterThan(0);
    expect(list.rows.map((r) => r.invoiceId)).toEqual(own.map((r) => r.id));
    for (const r of own) expect(list.where[r.id]).toBe(plainStatus(r.status, null));
  });

  it("opening someone else's invoice by URL is refused", async () => {
    const [other] = await q<{ id: string }>(`SELECT id FROM invoices WHERE requester_id IS DISTINCT FROM '${EMP.userId}' ORDER BY id LIMIT 1`);
    await expect(getInvoiceRecord(EMP, other!.id, { db })).rejects.toBeInstanceOf(Forbidden);
  });

  it("the plain words", () => {
    expect(["ManualEntry", "InReview", "OnHold"].map((s) => plainStatus(s, null))).toEqual(["in checks", "in checks", "in checks"]);
    expect(plainStatus("PendingApproval", "Dev")).toBe("waiting for Dev");
    expect(["Approved", "PaymentScheduled", "Paid", "Voided"].map((s) => plainStatus(s, null))).toEqual(["approved", "scheduled", "paid", "rejected"]);
  });
});

describe("Checks: the clerk records who asked for the bill", () => {
  it("the requester picker lists active employees, AP clerks and managers of every department, grouped by department", async () => {
    const opts = await reviewOptions(CLERK, { db });
    const ids = opts.people.map((p) => p.value);
    const rows = await q<{ id: string; role: string; status: string }>(`SELECT id, role, status FROM users WHERE id IN (${ids.map((i) => `'${i}'`).join(",")})`);
    expect(rows.every((r) => r.status === "active" && REQUESTER_ROLES.includes(r.role))).toBe(true);
    const [{ n }] = (await q<{ n: number }>(`SELECT count(*)::int n FROM users WHERE status = 'active' AND role IN ('employee','ap_clerk','approver')`)) as [{ n: number }];
    expect(ids).toHaveLength(n);
    expect(ids).toContain(EMP.userId);
    // Grouped: every person carries their department's name, and the list is sorted by department.
    expect(opts.people.every((p) => p.group.length > 0)).toBe(true);
    const order = opts.people.map((p) => p.departmentId ?? "");
    expect([...order].sort()).toEqual(order);
    // A terminated employee is not offered.
    const [gone] = await q<{ id: string }>(`SELECT id FROM users WHERE role = 'employee' AND status = 'terminated' LIMIT 1`);
    if (gone) expect(ids).not.toContain(gone.id);
  });

  it("the clerk sets the employee as requester → it routes to their manager → the employee sees it waiting, then approved; the employee can act on nothing", async () => {
    // A clean bill in the employee's department.
    const rows = await listChecks(CLERK, { db });
    const pick = rows.find((r) => r.flags.block === 0 && r.flags.warn === 0 && r.vendorId && r.currency === "CAD" && (r.totalCadCents ?? 0) > 0 && (r.totalCadCents ?? 0) < 1_000_000);
    expect(pick, "a clean bill under $10k").toBeTruthy();
    const id = pick!.invoiceId;
    await editInvoice(CLERK, id, { requesterId: EMP.userId, departmentId: empDept }, { db, reason: "Ordered by the dispatcher" });
    await acceptConfidentLines(CLERK, id, { db });
    const check = (await getCheck(CLERK, id, { db }))!;
    for (const l of check.lines.filter((x) => x.source === "suggested")) {
      await codeInvoiceLine(CLERK, id, l.lineNo, { glAccount: l.glAccount ?? "6900", departmentId: empDept, note: "Checked against the PDF" }, { db });
    }

    // Before it is submitted, the employee sees it "in checks", and cannot do the checks themselves.
    expect((await listInvoiceRecords(EMP, { pageSize: 200 }, { db })).where[id]).toBe("in checks");
    expect(await refused(() => listChecks(EMP, { db }))).toBe(true);
    expect(await refused(() => reviewOptions(EMP, { db }))).toBe(true);
    expect(await refused(() => editInvoice(EMP, id, { poId: null }, { db }))).toBe(true);
    expect(await refused(() => submitForApproval(EMP, id, { db }))).toBe(true);

    const plan = await submitForApproval(CLERK, id, { db });
    expect(plan.outcome).toBe("route");
    expect(plan.steps[0]!.assignedTo).toBe(MANAGER.userId);
    expect(plan.excludedApprovers.map((e) => e.userId)).toContain(EMP.userId);

    // My bills says who it is waiting for.
    expect((await listInvoiceRecords(EMP, { pageSize: 200 }, { db })).where[id]).toBe(`waiting for ${managerName}`);
    expect((await getInvoiceRecord(EMP, id, { db }))!.where).toBe(`waiting for ${managerName}`);

    // product.md: an employee trying to approve their own invoice is refused — on the server.
    expect(await refused(() => decideApproval(EMP, id, { action: "approve", comment: "mine", acknowledgedFlags: [] }, { db }))).toBe(true);
    expect(await refused(() => listApprovals(EMP, { db }))).toBe(true);
    expect((await db.select({ s: invoices.status }).from(invoices).where(eq(invoices.id, id)))[0]!.s).toBe("PendingApproval");

    // The manager approves (one step: under their limit).
    const detail = (await getApproval(MANAGER, id, { db }))!;
    expect(detail.you).toMatchObject({ canAct: true });
    await decideApproval(MANAGER, id, { action: "approve", comment: "OK", acknowledgedFlags: detail.plan!.attention.map((a) => a.code) }, { db });
    expect((await listInvoiceRecords(EMP, { pageSize: 200 }, { db })).where[id]).toBe("approved");

    // Payments: the employee can neither schedule nor release; the clerk schedules.
    expect(await refused(() => paymentsDb.schedule(EMP, { invoiceId: id }, { db }))).toBe(true);
    const s = await paymentsDb.schedule(CLERK, { invoiceId: id }, { db });
    expect(s.ok, JSON.stringify(s)).toBe(true);
    const paymentId = (s as { value: { paymentId: string } }).value.paymentId;
    expect(await refused(() => paymentsDb.release(EMP, { paymentId }, { db }))).toBe(true);
    expect((await listInvoiceRecords(EMP, { pageSize: 200 }, { db })).where[id]).toBe("scheduled");
    const r = await paymentsDb.release(FM, { paymentId }, { db });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    await paymentsDb.settle(CLERK, { paymentId, outcome: "SETTLED" }, { db });
    expect((await listInvoiceRecords(EMP, { pageSize: 200 }, { db })).where[id]).toBe("paid");

    // The history: who did what, with the employee as the requester.
    const rec = (await getInvoiceRecord(EMP, id, { db }))!;
    expect(rec.chain.find((x) => x.kind === "requested")).toMatchObject({ state: "done", person: { userId: EMP.userId } });
  });

  it("vendor changes refuse the employee on the server", async () => {
    const [v] = await q<{ id: string }>(`SELECT id FROM vendors WHERE status = 'active' ORDER BY id LIMIT 1`);
    expect(await refused(() => requestBankChange(EMP, v!.id, { institution: "003", transit: "12345", account: "1234567", channel: "phone", note: null } as never, { db }))).toBe(true);
    expect(await refused(() => holdVendor(EMP, v!.id, { reason: "test" }, { db }))).toBe(true);
    expect(await refused(() => approveVendor(EMP, v!.id, {}, { db }))).toBe(true);
    const [denied] = await q<{ n: number }>(`SELECT count(*)::int n FROM audit_events WHERE action = 'authz.denied' AND actor_id = '${EMP.userId}'`);
    expect(denied!.n).toBeGreaterThan(0);
  });

  it("the demo shortcut records an employee of the bill's department as the requester (not the clerk)", async () => {
    const sent = await sendCleanBillsToApproval(2, { db });
    for (const id of sent) {
      const [inv] = await db.select({ requesterId: invoices.requesterId, departmentId: invoices.departmentId }).from(invoices).where(eq(invoices.id, id));
      const [req] = await db.select({ role: users.role, departmentId: users.departmentId }).from(users).where(eq(users.id, inv!.requesterId!));
      const [hasEmployee] = await q<{ n: number }>(`SELECT count(*)::int n FROM users WHERE role = 'employee' AND status = 'active' AND department_id = '${inv!.departmentId}'`);
      if (hasEmployee!.n > 0) expect(req).toEqual({ role: "employee", departmentId: inv!.departmentId });
      expect(inv!.requesterId).not.toBe(CLERK.userId);
    }
  });
});
