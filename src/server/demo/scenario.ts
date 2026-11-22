import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Actor, ActorRole } from "@/contracts/actor";
import { getDb, type Db } from "@/server/db/client";
import { departments, invoiceFlags, invoiceLines, invoices } from "@/server/db/schema";
import { acceptConfidentLines, codeInvoiceLine, editInvoice, submitForApproval } from "@/server/pipeline";
import { demoRoster } from "@/server/session/roster";

/**
 * Demo control "Send a few clean bills to approval": does exactly what the AP Clerk would do on the
 * Checks screen, through the same services and as the clerk (every step audited under their name,
 * with "Demo control" as the reason): set the requester (the clerk — the demo cast is one person per
 * role), confirm every coding suggestion, submit. Only bills that are clean (no open validation
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
      await editInvoice(clerk, c.id, { requesterId: clerk.userId }, { db, reason: "Demo control: requester set" });
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
