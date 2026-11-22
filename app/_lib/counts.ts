import "server-only";

// The numbers on the sidebar and the home screen: what is waiting for the signed-in person.
// Each comes from the same service the page uses, so a count and its page never disagree.

import { listApprovals } from "@/server/dashboard/approvals";
import { listChecks } from "@/server/dashboard/checks";
import { paymentsDb } from "@/server/pipeline";
import type { Viewer } from "@/server/session/current-user";
import { canSee, type SectionKey } from "./nav";

export type Counts = Partial<Record<SectionKey, { n: number; alert?: boolean }>>;

export async function countsFor(viewer: Viewer): Promise<Counts> {
  const { role, actor, user } = viewer;
  const out: Counts = {};
  const tasks: Promise<void>[] = [];
  if (canSee(role, "checks")) {
    tasks.push(
      listChecks(actor).then((rows) => {
        out.checks = { n: rows.length, alert: rows.some((r) => r.reasons[0]?.kind === "unreadable" || r.reasons[0]?.kind === "blocking") };
      }),
    );
  }
  if (canSee(role, "approvals")) {
    tasks.push(
      listApprovals(actor).then((rows) => {
        const mine = rows.filter((r) => r.mine).length;
        out.approvals = { n: mine, alert: mine > 0 };
      }),
    );
  }
  if (canSee(role, "payments") || canSee(role, "to-release")) {
    tasks.push(
      paymentsDb.list(user.id).then(async (view) => {
        out["to-schedule"] = { n: view.awaitingPayment.length };
        const scheduled = view.payments.filter((p) => p.current.status === "scheduled");
        const releasers = await paymentsDb.eligibleReleasers(scheduled.map((p) => p.invoice.invoiceId));
        out["to-release"] = { n: scheduled.filter((_, i) => releasers[i]!.some((p) => p.userId === user.id)).length };
        const attention = view.payments.filter((p) => p.current.status === "failed" || p.current.status === "on_hold" || p.flags.some((f) => f.clearedAt === null)).length;
        out["needs-attention"] = { n: attention, alert: attention > 0 };
      }),
    );
  }
  await Promise.all(tasks);
  return out;
}
