import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Actor, ActorRole } from "@/contracts/actor";
import { getDb, type Db } from "@/server/db/client";
import { departments, invoiceFlags, invoiceLines, invoices, users } from "@/server/db/schema";
import { acceptConfidentLines, codeInvoiceLine, editInvoice, submitForApproval } from "@/server/pipeline";
import { demoRoster } from "@/server/session/roster";

/**
 * Demo control "Send a few clean bills to approval": does exactly what the AP Clerk would do on the
 * Checks screen, through the same services and as the clerk (every step audited under their name,
 * with "Demo control" as the reason): record the requester (an active employee of the bill's
 * department, as the clerk would — the clerk records who ordered it, and is rarely that person
 * themselves; the clerk only if that department has no employee), confirm every coding suggestion, submit. Only bills that are clean (no open validation
 * flags), not a second copy of an invoice already on file, and whose department manager is in the
 * cast are picked — so the demo's Operations Manager has them to approve.
 */
export async function sendCleanBillsToApproval(count = 3, opts: { db?: Db } = {}): Promise<string[]> {
  const db = opts.db ?? getDb();
  const cast = await demoRoster(db);
  const clerkUser = cast.find((c) => c.role === "clerk")?.user;
  if (!clerkUser) return [];
  const clerk: Actor = { userId: clerkUser.id, role: clerkUser.role as ActorRole };
  const castIds = cast.map((c) => c.user.id);
  // The first active employee of each department (by id): who the bill is recorded as requested by.
  const employees = await db.select({ id: users.id, departmentId: users.departmentId }).from(users).where(and(eq(users.role, "employee"), eq(users.status, "active"))).orderBy(asc(users.id));
  const employeeOf = new Map<string, string>();
  for (const e of employees) if (e.departmentId && !employeeOf.has(e.departmentId)) employeeOf.set(e.departmentId, e.id);

  const candidates = await db
    .select({ id: invoices.id, departmentId: invoices.departmentId })
    .from(invoices)
    .innerJoin(departments, eq(departments.id, invoices.departmentId))
    .where(
      and(
        eq(invoices.status, "InReview"),
        inArray(departments.managerId, castIds),
        sql`NOT EXISTS (SELECT 1 FROM invoices o WHERE o.id <> ${invoices.id} AND o.vendor_id = ${invoices.vendorId} AND o.invoice_number_norm = ${invoices.invoiceNumberNorm})`,
        sql`${invoices.vendorId} IS NOT NULL AND ${invoices.departmentId} IS NOT NULL AND ${invoices.totalCadCents} > 0`,
        sql`NOT EXISTS (SELECT 1 FROM ${invoiceFlags} f WHERE f.invoice_id = ${invoices.id} AND f.status = 'open' AND f.source <> 'coding' AND f.severity IN ('block','warn'))`,
      ),
    )
    .orderBy(asc(invoices.dueDate));

  const sent: string[] = [];
  for (const c of candidates) {
    if (sent.length >= count) break;
    try {
      const requesterId = (c.departmentId && employeeOf.get(c.departmentId)) || clerk.userId;
      await editInvoice(clerk, c.id, { requesterId }, { db, reason: "Demo control: requester recorded" });
      await acceptConfidentLines(clerk, c.id, { db, minimum: "medium" });
      const open = await db.select().from(invoiceLines).where(and(eq(invoiceLines.invoiceId, c.id), eq(invoiceLines.codingSource, "suggested")));
      for (const l of open) {
        if (!l.glAccountCode || !l.departmentId) throw new Error("no suggestion to confirm");
        await codeInvoiceLine(clerk, c.id, l.lineNo, { glAccount: l.glAccountCode, departmentId: l.departmentId, note: "Demo control: suggestion confirmed" }, { db });
      }
      const plan = await submitForApproval(clerk, c.id, { db });
      if (plan.outcome === "route") sent.push(c.id);
    } catch {
      // Not clean after all (e.g. a coding doubt): leave it in Checks for a person.
    }
  }
  return sent;
}
