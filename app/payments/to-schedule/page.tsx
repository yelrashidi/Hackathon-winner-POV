import type { Metadata } from "next";
import { getCurrentUser } from "@/server/session/current-user";
import { AwaitingPayment } from "../_components/AwaitingPayment";
import { NotForYourRole } from "../_components/NotForYourRole";
import { PageHeader } from "../_components/PageHeader";
import { canSeePage, dashboardRole, pageByKey } from "../_lib/access";
import { getPayments } from "../_lib/data";

export const metadata: Metadata = { title: "To schedule" };

export default async function ToSchedulePage() {
  const [user, view] = await Promise.all([getCurrentUser(), getPayments()]);
  const role = dashboardRole(user);
  if (!canSeePage(role, "to-schedule")) return <NotForYourRole page={pageByKey("to-schedule")} user={user} />;

  return (
    <>
      <PageHeader
        title="To schedule"
        description="Approved invoices that have no payment yet. Scheduling picks the pay date; a Finance Manager or Controller releases the payment afterwards."
      />
      <AwaitingPayment invoices={view.awaitingPayment} role={role} />
    </>
  );
}
