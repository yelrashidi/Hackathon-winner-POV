import type { Metadata } from "next";
import { getCurrentUser } from "@/server/session/current-user";
import { NeedsAttention } from "../_components/NeedsAttention";
import { NotForYourRole } from "../_components/NotForYourRole";
import { PageHeader } from "../_components/PageHeader";
import { ReleaseQueueTable, type ReleaseItem } from "../_components/ReleaseQueueTable";
import { canSeePage, dashboardRole, pageByKey } from "../_lib/access";
import { getPayments } from "../_lib/data";
import { FAILURE_REASONS } from "../_lib/failure-reasons";
import { releaseBlockers, whoCanRelease } from "../_lib/release-check";

export const metadata: Metadata = { title: "Release queue" };

const DESCRIPTION = {
  finance_manager:
    "Scheduled payments waiting for the final OK. You can release up to $100,000 CAD, never a payment you approved, requested or scheduled.",
  controller:
    "Every scheduled payment. You can release any amount, never a payment you approved, requested or scheduled.",
  other: "Scheduled payments and who is allowed to release each one. View only.",
};

export default async function ToReleasePage() {
  const [user, view] = await Promise.all([getCurrentUser(), getPayments()]);
  const role = dashboardRole(user);
  if (!canSeePage(role, "to-release")) return <NotForYourRole page={pageByKey("to-release")} user={user} />;

  const isReleaser = role === "finance_manager" || role === "controller";
  const items: ReleaseItem[] = view.payments
    .filter((p) => p.current.status === "scheduled")
    .map((row) => ({ row, blockers: releaseBlockers(user, row), releasers: whoCanRelease(row) }))
    // Releasers see what they can release first; then by pay date.
    .sort(
      (a, b) =>
        (isReleaser ? Number(a.blockers.length > 0) - Number(b.blockers.length > 0) : 0) ||
        a.row.current.scheduledDate.localeCompare(b.row.current.scheduledDate),
    );
  const releasable = items.filter((i) => i.blockers.length === 0).length;

  const escalations = view.payments.filter(
    (p) =>
      p.current.status === "failed" &&
      p.current.failureCode !== null &&
      FAILURE_REASONS[p.current.failureCode].group === "escalate",
  );

  return (
    <>
      <PageHeader
        title="Release queue"
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
          title="Escalations"
          description="Held by the bank as possible fraud, or frozen. No retry: the Controller reviews."
          emptyText="No escalations."
        />
      )}
    </>
  );
}
