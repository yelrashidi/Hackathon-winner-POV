import type { Metadata } from "next";
import { connection } from "next/server";
import { getCurrentUser } from "@/server/session/current-user";
import { FilterBar } from "./_components/FilterBar";
import { PageHeader } from "./_components/PageHeader";
import { PaymentsTable } from "./_components/PaymentsTable";
import { statusLabel } from "./_components/StatusBadge";
import { SummaryCards } from "./_components/SummaryCards";
import { NotForYourRole } from "./_components/NotForYourRole";
import { canSeePage, dashboardRole, pageByKey } from "./_lib/access";
import { getPayments } from "./_lib/data";
import { todayIso } from "./_lib/format";
import type { PaymentStatus } from "@/contracts/payment";
import { parseQueueSort, searchAndSort } from "@/server/dashboard/list-query";
import { SORT_OPTIONS } from "../_lib/invoice-sort";

// The overview already lists payments by pay date, earliest first: that is its default sort.
const DEFAULT_SORT = "oldest";
const PAY_DATE_SORTS = SORT_OPTIONS.map((o) => (o.value === "newest" || o.value === "oldest" ? { ...o, label: `${o.label} (pay date)` } : o));

export const metadata: Metadata = { title: "Overview" };

const STATUSES: PaymentStatus[] = ["scheduled", "released", "settled", "failed", "on_hold", "cancelled"];

export default async function OverviewPage({ searchParams }: PageProps<"/payments">) {
  // "Next 7 days" depends on today's date, so read it per request, not at build time.
  await connection();
  const user = await getCurrentUser();
  const role = dashboardRole(user);
  if (!canSeePage(role, "overview")) return <NotForYourRole page={pageByKey("overview")} user={user} />;
  const [view, params] = await Promise.all([getPayments(), searchParams]);

  const vendors = [...new Map(view.payments.map((p) => [p.invoice.vendorId, p.invoice.vendorName])).entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));

  // Ignore unknown filter values instead of showing an empty table.
  const status = STATUSES.find((s) => s === first(params.status)) ?? "";
  const vendor = vendors.find((v) => v.value === first(params.vendor))?.value ?? "";
  const search = first(params.q).trim();
  const picked = parseQueueSort(first(params.sort));
  const sort = picked === "default" ? DEFAULT_SORT : picked;
  const rows = searchAndSort(
    view.payments.filter((p) => (!status || p.current.status === status) && (!vendor || p.invoice.vendorId === vendor)),
    { search, sort },
    (p) => ({ text: [p.invoice.vendorName, p.invoice.vendorInvoiceNumber, p.invoice.invoiceId], vendor: p.invoice.vendorName, date: p.current.scheduledDate, id: p.invoice.invoiceId }),
  );

  return (
    <>
      <PageHeader
        title="Payments overview"
        description="Every supplier payment and where it stands, from scheduled to settled."
      />
      <SummaryCards
        view={view}
        today={todayIso()}
        links={{
          awaiting: canSeePage(role, "to-schedule") ? "/payments/to-schedule" : undefined,
          release: canSeePage(role, "to-release") ? "/payments/to-release" : undefined,
          attention: canSeePage(role, "needs-attention") ? "/payments/needs-attention" : undefined,
        }}
      />
      <FilterBar
        // Remount when the URL's filters change so the selects show them (e.g. after "Clear filters").
        key={`${status}|${vendor}|${search}|${sort}`}
        statuses={STATUSES.map((s) => ({ value: s, label: statusLabel(s) }))}
        vendors={vendors}
        status={status}
        vendor={vendor}
        search={search}
        sort={sort}
        sortOptions={PAY_DATE_SORTS}
        defaultSort={DEFAULT_SORT}
      />
      <PaymentsTable rows={rows} role={role} filtered={Boolean(status || vendor || search)} />
    </>
  );
}

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}
