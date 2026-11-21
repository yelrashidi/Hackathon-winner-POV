import type { Metadata } from "next";
import { getCurrentUser } from "@/server/session/current-user";
import { FlagCounts } from "../_components/Flags";
import { NeedsAttention } from "../_components/NeedsAttention";
import { NotForYourRole } from "../_components/NotForYourRole";
import { PageHeader } from "../_components/PageHeader";
import { canSeePage, dashboardRole, pageByKey } from "../_lib/access";
import { getPayments, needsAttention, openFlagCounts, openFlags, URGENCY_ORDER, type PaymentRow } from "../_lib/data";

export const metadata: Metadata = { title: "Needs attention" };

/** Most urgent open flag first (critical, high, low, none), then the newest failure. */
function urgencyRank(row: PaymentRow): number {
  const top = openFlags(row)[0];
  return top ? URGENCY_ORDER.indexOf(top.urgency) : URGENCY_ORDER.length;
}

export default async function NeedsAttentionPage() {
  const [user, view] = await Promise.all([getCurrentUser(), getPayments()]);
  const role = dashboardRole(user);
  if (!canSeePage(role, "needs-attention")) {
    return <NotForYourRole page={pageByKey("needs-attention")} user={user} />;
  }

  const rows = view.payments
    .filter(needsAttention)
    .sort(
      (a, b) =>
        urgencyRank(a) - urgencyRank(b) || (b.current.failedAt ?? "").localeCompare(a.current.failedAt ?? ""),
    );

  return (
    <>
      <PageHeader
        title="Needs attention"
        description="Payments that failed at the bank, are on hold, or carry an open flag. The supplier is still owed until each one is fixed and paid. Nothing retries automatically."
      >
        <p className="rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-sm">
          <span className="mr-2 text-xs font-medium uppercase tracking-wide text-slate-400">Open flags</span>
          <FlagCounts counts={openFlagCounts(view.payments)} />
        </p>
      </PageHeader>
      <NeedsAttention rows={rows} role={role} user={user} description="Most urgent first. Each one says what to do next." />
    </>
  );
}
