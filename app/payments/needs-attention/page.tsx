import type { Metadata } from "next";
import { getCurrentUser } from "@/server/session/current-user";
import { NeedsAttention } from "../_components/NeedsAttention";
import { NotForYourRole } from "../_components/NotForYourRole";
import { PageHeader } from "../_components/PageHeader";
import { canSeePage, dashboardRole, pageByKey } from "../_lib/access";
import { getPayments, needsAttention } from "../_lib/data";

export const metadata: Metadata = { title: "Needs attention" };

export default async function NeedsAttentionPage() {
  const [user, view] = await Promise.all([getCurrentUser(), getPayments()]);
  const role = dashboardRole(user);
  if (!canSeePage(role, "needs-attention")) {
    return <NotForYourRole page={pageByKey("needs-attention")} user={user} />;
  }

  // Failures first (newest first), then holds.
  const rows = view.payments
    .filter(needsAttention)
    .sort(
      (a, b) =>
        Number(a.current.status === "on_hold") - Number(b.current.status === "on_hold") ||
        (b.current.failedAt ?? "").localeCompare(a.current.failedAt ?? ""),
    );

  return (
    <>
      <PageHeader
        title="Needs attention"
        description="Payments that failed at the bank or are on hold. The supplier is still owed until each one is fixed and paid. Nothing retries automatically."
      />
      <NeedsAttention rows={rows} role={role} description="Each one says what happened and what to do next." />
    </>
  );
}
