import type { Metadata } from "next";
import { getCurrentUser } from "@/server/session/current-user";
import { NeedsAttention } from "../_components/NeedsAttention";
import { NotForYourRole } from "../_components/NotForYourRole";
import { PageHeader } from "../_components/PageHeader";
import { ReleaseQueueTable, type ReleaseItem } from "../_components/ReleaseQueueTable";
import { canSeePage, dashboardRole, pageByKey } from "../_lib/access";
import { getPayments } from "../_lib/data";
import { paymentsDb } from "@/server/pipeline";
import { listSwitchableUsers } from "@/server/session/current-user";

export const metadata: Metadata = { title: "Release queue" };

const DESCRIPTION = {
  finance_manager:
    "Scheduled payments waiting for the final OK. You can release up to $100,000 CAD, never a payment you approved, requested or scheduled.",
  controller:
    "Only the payments the Finance Manager can't release: over $100,000 CAD (P10), or ones the Finance Manager approved, scheduled or requested (P11). You never release one you approved yourself.",
  other: "Scheduled payments and who is allowed to release each one. View only.",
};

export default async function ToReleasePage() {
  const [user, view] = await Promise.all([getCurrentUser(), getPayments()]);
  const role = dashboardRole(user);
  if (!canSeePage(role, "to-release")) return <NotForYourRole page={pageByKey("to-release")} user={user} />;

  const isReleaser = role === "finance_manager" || role === "controller";
  const all = view.payments.filter((p) => p.current.status === "scheduled");
  const [allReleasers, people] = await Promise.all([paymentsDb.eligibleReleasers(all.map((row) => row.invoice.invoiceId)), listSwitchableUsers()]);
  const fm = new Set(people.filter((u) => u.role === "finance_manager").map((u) => u.id));
  // The Admin sees only what no Finance Manager may release (the list already leaves the Admin out otherwise).
  const keep = all.map((_, i) => role !== "controller" || !(allReleasers[i] ?? []).some((p) => fm.has(p.userId)));
  const scheduled = all.filter((_, i) => keep[i]);
  const releasers = allReleasers.filter((_, i) => keep[i]);
  const items: ReleaseItem[] = scheduled
    .map((row, i) => ({ row, blockers: row.releaseCheck.reasons, releasers: releasers[i] ?? [] }))
    // Releasers see what they can release first; then by pay date.
    .sort(
      (a, b) =>
        (isReleaser ? Number(a.blockers.length > 0) - Number(b.blockers.length > 0) : 0) ||
        a.row.current.scheduledDate.localeCompare(b.row.current.scheduledDate),
    );
  const releasable = items.filter((i) => i.blockers.length === 0).length;

  const escalations = view.payments.filter(
    (p) =>
      p.current.status === "failed" && p.current.failure?.retryRule === "ESCALATE" && p.flags.some((f) => f.urgency === "critical" && f.clearedAt === null),
  );

  return (
    <>
      <PageHeader
        title={role === "controller" ? "Releases for the Admin" : "Release queue"}
        description={role === "finance_manager" || role === "controller" ? DESCRIPTION[role] : DESCRIPTION.other}
      >
        {isReleaser && (
          <p className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 shadow-sm">
            <span className="font-semibold text-emerald-700">{releasable}</span> you can release ·{" "}
            <span className="font-semibold text-slate-900">{items.length - releasable}</span> need someone else
          </p>
        )}
      </PageHeader>
      <ReleaseQueueTable items={items} showYourCheck={isReleaser} showActions={isReleaser} />
      {(role === "controller" || role === "auditor") && (
        <NeedsAttention
          rows={escalations}
          role={role}
          user={user}
          title="Escalations"
          description="Held by the bank as possible fraud. No retry: the Controller reviews and clears the hold."
          emptyText="No escalations."
        />
      )}
    </>
  );
}
