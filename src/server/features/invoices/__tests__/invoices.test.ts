import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import type { Actor, ActorRole } from "@/contracts/actor";
import { Forbidden } from "@/server/core/authorize";
import type { Db } from "@/server/db/client";
import { createSeededDb } from "@/server/db/__tests__/helpers";
import { getInvoiceRecord, invoiceScope, listInvoiceRecords } from "..";

/**
 * Invoice records follow the roles matrix's "View invoices" row:
 * employee own submissions · approver own department · clerk, FM, controller, auditor all.
 */

let db: Db;
let client: PGlite;
const q = async <T>(sql: string) => (await client.query<T>(sql)).rows;
const as = (userId: string, role: ActorRole): Actor => ({ userId, role });

let total = 0;
let manager: Actor;
let managerDept = "";
let employee: Actor;

beforeAll(async () => {
  ({ db, client } = await createSeededDb({ validateHistory: false }));
  await client.exec("SET ROLE ap_app");
  total = (await q<{ n: number }>("SELECT count(*)::int n FROM invoices"))[0]!.n;
  // A department manager whose department has invoices, and an employee who requested some.
  const [m] = await q<{ id: string; department_id: string }>(
    "SELECT u.id, u.department_id FROM users u WHERE u.role = 'approver' AND u.status = 'active' AND EXISTS (SELECT 1 FROM invoices i WHERE i.department_id = u.department_id) ORDER BY u.id LIMIT 1",
  );
  manager = as(m!.id, "approver");
  managerDept = m!.department_id;
  const [e] = await q<{ id: string }>("SELECT u.id FROM users u WHERE u.role = 'employee' AND EXISTS (SELECT 1 FROM invoices i WHERE i.requester_id = u.id) ORDER BY u.id LIMIT 1");
  employee = as(e!.id, "employee");
}, 120_000);

describe("who sees which invoices", () => {
  it.each<[string, Actor]>([
    ["AP Clerk", as("U004", "ap_clerk")],
    ["Finance Manager", as("U003", "finance_manager")],
    ["Controller", as("U002", "controller_admin")],
    ["Auditor", as("U006", "auditor")],
  ])("%s sees every invoice, history included", async (_, actor) => {
    const list = await listInvoiceRecords(actor, { pageSize: 1 }, { db });
    expect(list.scope).toEqual({ kind: "all" });
    expect(list.total).toBe(total);
  });

  it("a manager sees only their own department's invoices", async () => {
    const list = await listInvoiceRecords(manager, { pageSize: 200 }, { db });
    expect(list.scope).toEqual({ kind: "department", departmentId: managerDept });
    const deptCount = (await q<{ n: number }>(`SELECT count(*)::int n FROM invoices WHERE department_id = '${managerDept}'`))[0]!.n;
    expect(list.total).toBe(deptCount);
    expect(list.total).toBeLessThan(total);
  });

  it("a manager opening another department's invoice is refused, and the attempt is logged", async () => {
    const [other] = await q<{ id: string }>(`SELECT id FROM invoices WHERE department_id IS NOT NULL AND department_id <> '${managerDept}' ORDER BY id LIMIT 1`);
    const before = (await q<{ n: number }>("SELECT count(*)::int n FROM audit_events WHERE action = 'authz.denied' AND metadata->>'attempted' = 'invoice.view'"))[0]!.n;
    await expect(getInvoiceRecord(manager, other!.id, { db })).rejects.toBeInstanceOf(Forbidden);
    const after = (await q<{ n: number }>("SELECT count(*)::int n FROM audit_events WHERE action = 'authz.denied' AND metadata->>'attempted' = 'invoice.view'"))[0]!.n;
    expect(after).toBe(before + 1);
  });

  it("an employee sees only the invoices they requested", async () => {
    expect(await invoiceScope(employee, { db })).toEqual({ kind: "own", userId: employee.userId });
    const list = await listInvoiceRecords(employee, { pageSize: 200 }, { db });
    const own = (await q<{ n: number }>(`SELECT count(*)::int n FROM invoices WHERE requester_id = '${employee.userId}'`))[0]!.n;
    expect(list.total).toBe(own);
  });
});

describe("the invoice record", () => {
  it("shows the invoice with who did what, but not the audit log itself", async () => {
    const [paid] = await q<{ id: string }>("SELECT i.id FROM invoices i JOIN payments p ON p.invoice_id = i.id WHERE i.status = 'Paid' AND p.released_by IS NOT NULL ORDER BY i.id LIMIT 1");
    const r = (await getInvoiceRecord(as("U004", "ap_clerk"), paid!.id, { db }))!;
    expect(r.invoice.invoiceId).toBe(paid!.id);
    expect(r.chain.map((s) => s.kind)).toEqual(expect.arrayContaining(["requested", "checked", "approved", "scheduled", "released"]));
    expect(r.chain.find((s) => s.kind === "released")).toMatchObject({ state: "done" });
    // The audit log (events with before/after, control checks, validation runs) stays in /audit.
    for (const key of ["timeline", "controls", "validationRuns", "extraction"]) expect(r).not.toHaveProperty(key);
  });

  it("an unknown invoice is null, not an error", async () => {
    expect(await getInvoiceRecord(as("U004", "ap_clerk"), "NOPE-1", { db })).toBeNull();
  });
});
