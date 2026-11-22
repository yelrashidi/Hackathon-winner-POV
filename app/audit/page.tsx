import type { Metadata } from "next";
import Link from "next/link";
import { can } from "@/server/core/authorize";
import { auditList, PAST_STATUSES } from "@/server/dashboard/audit";
import { getViewer } from "@/server/session/current-user";
import { fieldClass } from "../_lib/styles";
import { NotForYourRole } from "../_components/NotForYourRole";
import { Day, EmptyState, InvoiceStatus, invoiceStatusLabel, Money, PageHeader, Pill, Table, td } from "../_components/ui";
import { first, formatDay } from "../_lib/format";
import { canSee } from "../_lib/nav";

export const metadata: Metadata = { title: "Audit trail" };

const ALL_STATUSES = ["ManualEntry", "InReview", "OnHold", "PendingApproval", ...PAST_STATUSES];
const PAGE_SIZE = 50;
const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

export default async function AuditPage({ searchParams }: PageProps<"/audit">) {
  const viewer = await getViewer();
  if (!canSee(viewer?.role ?? null, "audit")) return <NotForYourRole sectionKey="audit" viewer={viewer} />;
  const params = await searchParams;
  const auditor = viewer!.role === "auditor";
  const statuses = auditor ? PAST_STATUSES : ALL_STATUSES;
  const q = {
    search: first(params.q) || undefined,
    status: statuses.includes(first(params.status)) ? first(params.status) : undefined,
    from: isDay(first(params.from)) ? first(params.from) : undefined,
    to: isDay(first(params.to)) ? first(params.to) : undefined,
    hasOverrides: first(params.overrides) === "1" || undefined,
    hasOpenBlocking: first(params.blocking) === "1" || undefined,
    page: Math.max(1, Number(first(params.page)) || 1),
    pageSize: PAGE_SIZE,
  };
  const list = await auditList(viewer!.actor, q);
  const pages = Math.max(1, Math.ceil(list.total / PAGE_SIZE));
  const canExport = can(viewer!.actor, "audit.export");
  const link = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams();
    const merged = { q: q.search, status: q.status, from: q.from, to: q.to, overrides: q.hasOverrides ? "1" : undefined, blocking: q.hasOpenBlocking ? "1" : undefined, page: String(q.page), ...patch };
    for (const [k, v] of Object.entries(merged)) if (v && !(k === "page" && v === "1")) next.set(k, v);
    const s = next.toString();
    return s ? `/audit?${s}` : "/audit";
  };
  const exportHref = `/audit/export?${new URLSearchParams(Object.entries({ from: q.from, to: q.to }).filter(([, v]) => v) as [string, string][]).toString()}`;

  return (
    <>
      <PageHeader
        title="Audit trail"
        description={
          auditor
            ? "Every past invoice — approved, paid, closed or voided. Open one to see its full trail: the original, what was read, the coding, every flag and who closed it, the approval chain, the payment and the account it went to."
            : "Every invoice, history and new. Open one to see who did what, when, on whose behalf, and what changed. Read-only for everyone."
        }
      >
        {canExport && (
          <a href={exportHref} className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-slate-800 shadow-sm ring-1 ring-inset ring-slate-300 hover:bg-slate-50">
            Export CSV{q.from || q.to ? " (date range)" : ""}
          </a>
        )}
      </PageHeader>

      <form className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-6" action="/audit">
        <label className="text-xs font-medium text-slate-600 lg:col-span-2">
          Search
          <input name="q" defaultValue={q.search ?? ""} placeholder="Invoice id, number or vendor" className={`mt-1 ${fieldClass}`} />
        </label>
        <label className="text-xs font-medium text-slate-600">
          Status
          <select name="status" defaultValue={q.status ?? ""} className={`mt-1 ${fieldClass}`}>
            <option value="">{auditor ? "All past" : "All"}</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {invoiceStatusLabel(s)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-slate-600">
          From
          <input type="date" name="from" defaultValue={q.from ?? ""} className={`mt-1 ${fieldClass}`} />
        </label>
        <label className="text-xs font-medium text-slate-600">
          To
          <input type="date" name="to" defaultValue={q.to ?? ""} className={`mt-1 ${fieldClass}`} />
        </label>
        <div className="flex flex-col justify-end gap-1.5 text-xs text-slate-600">
          <label className="flex items-center gap-2">
            <input type="checkbox" name="overrides" value="1" defaultChecked={q.hasOverrides} className="accent-(--brim-link)" /> Has overrides
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="blocking" value="1" defaultChecked={q.hasOpenBlocking} className="accent-(--brim-link)" /> Open blocking flag
          </label>
        </div>
        <div className="flex items-center gap-3 sm:col-span-2 lg:col-span-6">
          <button type="submit" className="rounded-lg bg-(--brim-accent) px-4 py-1.5 text-sm font-semibold text-(--brim-on-accent) hover:bg-(--brim-accent-hover)">
            Filter
          </button>
          <Link href="/audit" className="text-sm text-slate-500 hover:underline">
            Clear
          </Link>
          <span className="ml-auto text-sm text-slate-500">
            {list.total} invoice{list.total === 1 ? "" : "s"}
          </span>
        </div>
      </form>

      {list.rows.length === 0 ? (
        <EmptyState title="No invoices match." />
      ) : (
        <Table head={["Invoice", "Vendor", "Date", "Total", "Status", "Flags", "Approved by", "Payment", "Events"]}>
          {list.rows.map((r) => (
            <tr key={r.invoiceId} className="hover:bg-slate-50/70">
              <td className={td}>
                <Link href={`/audit/${r.invoiceId}`} className="whitespace-nowrap font-mono text-xs font-semibold text-(--brim-link) hover:underline">
                  {r.invoiceId}
                </Link>
                <p className="font-mono text-xs text-slate-500">{r.invoiceNumber ?? "—"}</p>
              </td>
              <td className={`${td} max-w-56`}>
                <p className="truncate text-slate-900">{r.vendorName ?? "—"}</p>
                <p className="text-xs text-slate-500">{r.source}</p>
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
              <td className={`${td} whitespace-nowrap text-xs`}>
                {r.flags.openBlocking > 0 && <Pill tone="red">{r.flags.openBlocking} blocking</Pill>} {r.flags.overridden > 0 && <Pill tone="amber">{r.flags.overridden} overridden</Pill>}
                {r.flags.open + r.flags.overridden + r.flags.resolved === 0 ? <span className="text-slate-400">none</span> : <span className="block text-slate-500">{r.flags.open} open · {r.flags.resolved} resolved</span>}
              </td>
              <td className={`${td} text-xs`}>{r.finalApprover ? <>{r.finalApprover.person.name}</> : <span className="text-slate-400">—</span>}</td>
              <td className={`${td} text-xs`}>
                {r.payment ? (
                  <>
                    {r.payment.status}
                    {r.payment.paidDate ? ` ${formatDay(r.payment.paidDate)}` : ""}
                    {r.payment.releasedBy && <span className="block text-slate-500">released by {r.payment.releasedBy.name}</span>}
                  </>
                ) : (
                  <span className="text-slate-400">—</span>
                )}
              </td>
              <td className={`${td} text-xs tabular-nums text-slate-500`}>{r.eventCount}</td>
            </tr>
          ))}
        </Table>
      )}
      {pages > 1 && (
        <nav className="flex items-center justify-between text-sm" aria-label="Pages">
          {q.page > 1 ? <Link href={link({ page: String(q.page - 1) })} className="font-medium text-(--brim-link) hover:underline">← Newer</Link> : <span />}
          <span className="text-slate-500">
            Page {q.page} of {pages}
          </span>
          {q.page < pages ? <Link href={link({ page: String(q.page + 1) })} className="font-medium text-(--brim-link) hover:underline">Older →</Link> : <span />}
        </nav>
      )}
    </>
  );
}
