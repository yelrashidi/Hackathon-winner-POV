import type { Metadata } from "next";
import Link from "next/link";
import { listInvoiceRecords } from "@/server/features/invoices";
import { getViewer } from "@/server/session/current-user";
import { NotForYourRole } from "../_components/NotForYourRole";
import { Day, EmptyState, InvoiceStatus, Money, PageHeader, Table, td } from "../_components/ui";
import { first } from "../_lib/format";
import { canSee } from "../_lib/nav";
import { fieldClass } from "../_lib/styles";

export const metadata: Metadata = { title: "Invoices" };

const STATUSES = ["ManualEntry", "InReview", "OnHold", "PendingApproval", "Approved", "PaymentScheduled", "Paid", "Closed", "Voided"];
const PAGE_SIZE = 50;

// Read-only invoice records, history included, scoped by role (roles matrix "View invoices"):
// managers see their department's, everyone else in finance sees all. The full audit log is /audit.
export default async function InvoicesPage({ searchParams }: PageProps<"/invoices">) {
  const viewer = await getViewer();
  if (!canSee(viewer?.role ?? null, "invoices")) return <NotForYourRole sectionKey="invoices" viewer={viewer} />;
  const params = await searchParams;
  const q = {
    search: first(params.q) || undefined,
    status: STATUSES.includes(first(params.status)) ? first(params.status) : undefined,
    page: Math.max(1, Number(first(params.page)) || 1),
    pageSize: PAGE_SIZE,
  };
  const list = await listInvoiceRecords(viewer!.actor, q);
  const pages = Math.max(1, Math.ceil(list.total / PAGE_SIZE));
  const link = (page: number) => {
    const next = new URLSearchParams();
    if (q.search) next.set("q", q.search);
    if (q.status) next.set("status", q.status);
    if (page > 1) next.set("page", String(page));
    const s = next.toString();
    return s ? `/invoices?${s}` : "/invoices";
  };
  const scopeText = list.scope.kind === "department" ? "Your department's invoices" : list.scope.kind === "own" ? "Invoices you requested" : "Every invoice";

  return (
    <>
      <PageHeader
        title="Invoices"
        description={`${scopeText}, in progress and paid, history included. Open one to see the document, the coding, the approvals, the payment, and who did what. Read-only.`}
      />
      <form className="flex flex-wrap gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm" action="/invoices">
        <input name="q" defaultValue={q.search} placeholder="Invoice, number or vendor" aria-label="Search" className={`min-w-56 flex-1 ${fieldClass}`} />
        <select name="status" defaultValue={q.status ?? ""} aria-label="Status" className={fieldClass}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button type="submit" className="rounded-lg bg-(--brim-accent) px-4 py-2 text-sm font-semibold text-(--brim-on-accent) hover:bg-(--brim-accent-hover)">
          Search
        </button>
      </form>

      {list.rows.length === 0 ? (
        <EmptyState title="No invoices match." />
      ) : (
        <Table head={["Invoice", "Vendor", "Date", "Total", "Status", "Approved by", "Payment"]}>
          {list.rows.map((r) => (
            <tr key={r.invoiceId} className="hover:bg-slate-50/70">
              <td className={td}>
                <Link href={`/invoices/${encodeURIComponent(r.invoiceId)}`} className="whitespace-nowrap font-mono text-xs font-semibold text-(--brim-link) hover:underline">
                  {r.invoiceId}
                </Link>
                <p className="font-mono text-xs text-slate-500">{r.invoiceNumber ?? "—"}</p>
              </td>
              <td className={`${td} max-w-56`}>
                <p className="truncate text-slate-900">{r.vendorName ?? "—"}</p>
              </td>
              <td className={td}>
                <Day value={r.invoiceDate} />
              </td>
              <td className={`${td} whitespace-nowrap`}>
                <Money cents={r.totalCents} currency={r.currency} cadCents={r.totalCadCents} />
              </td>
              <td className={td}>
                <InvoiceStatus status={r.status} />
              </td>
              <td className={`${td} text-xs`}>{r.finalApprover ? r.finalApprover.person.name : <span className="text-slate-400">—</span>}</td>
              <td className={`${td} text-xs`}>
                {r.payment ? (
                  <>
                    {r.payment.status}
                    {r.payment.releasedBy && <span className="block text-slate-500">released by {r.payment.releasedBy.name}</span>}
                  </>
                ) : (
                  <span className="text-slate-400">—</span>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-between text-sm text-slate-600">
          <span>
            {list.total} invoices · page {q.page} of {pages}
          </span>
          <span className="flex gap-3">
            {q.page > 1 && <Link href={link(q.page - 1)} className="text-(--brim-link) hover:underline">← Previous</Link>}
            {q.page < pages && <Link href={link(q.page + 1)} className="text-(--brim-link) hover:underline">Next →</Link>}
          </span>
        </div>
      )}
    </>
  );
}
