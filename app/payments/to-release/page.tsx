import type { Metadata } from "next";
import { getCurrentUser } from "@/server/session/current-user";
import { NeedsAttention } from "../_components/NeedsAttention";
import { NotForYourRole } from "../_components/NotForYourRole";
import { PageHeader } from "../_components/PageHeader";
import { ReleaseQueueTable, type ReleaseItem } from "../_components/ReleaseQueueTable";
import { canSeePage, dashboardRole, pageByKey, roleLabelOf } from "../_lib/access";
import { getPayments } from "../_lib/data";
import { paymentsDb } from "@/server/pipeline";

export const metadata: Metadata = { title: "Release queue" };

const DESCRIPTION = {
  finance_manager:
    "Scheduled payments waiting for the final OK. You can release up to $100,000 CAD, never a payment you approved, requested or scheduled.",
  controller:
    "Every scheduled payment. Over $100,000 CAD (P10), or ones the Finance Manager approved, scheduled or requested (P11), only the Controller or the CFO can release, and never one they approved themselves.",
  other: "Scheduled payments and who is allowed to release each one. View only.",
};

export default async function ToReleasePage() {
  const [user, view] = await Promise.all([getCurrentUser(), getPayments()]);
  const role = dashboardRole(user);
  if (!canSeePage(role, "to-release")) return <NotForYourRole page={pageByKey("to-release")} user={user} />;

  const isReleaser = role === "finance_manager" || role === "controller";
  const all = view.payments.filter((p) => p.current.status === "scheduled");
  // The Controller (Admin) releases any amount, so both releasers see every scheduled payment.
  const scheduled = all;
  const releasers = await paymentsDb.eligibleReleasers(all.map((row) => row.invoice.invoiceId));
  const items: ReleaseItem[] = scheduled
    .map((row, i) => ({ row, blockers: row.releaseCheck.reasons, releasers: releasers[i] ?? [] }))
    // Releasers see what they can release first; then the one that became ready to release most
    // recently (scheduled latest) on top; ties (e.g. seeded together) by pay date.
    .sort(
      (a, b) =>
        (isReleaser ? Number(a.blockers.length > 0) - Number(b.blockers.length > 0) : 0) ||
        (b.row.current.scheduledAt ?? "").localeCompare(a.row.current.scheduledAt ?? "") ||
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
        title={role === "controller" && user ? `Releases for the ${roleLabelOf(user)}` : "Release queue"}
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
