import type { Metadata } from "next";
import Link from "next/link";
import { listChecks, type CheckReasonKind } from "@/server/dashboard/checks";
import { parseQueueSort, searchAndSort } from "@/server/dashboard/list-query";
import { getViewer } from "@/server/session/current-user";
import { NotForYourRole } from "../_components/NotForYourRole";
import { SortSelect } from "../_components/SortSelect";
import { Day, EmptyState, InvoiceStatus, Money, PageHeader, Pill, Table, td, type PillTone } from "../_components/ui";
import { first } from "../_lib/format";
import { queueSortOptions } from "../_lib/invoice-sort";
import { fieldClass } from "../_lib/styles";
import { canSee } from "../_lib/nav";

export const metadata: Metadata = { title: "Checks" };

const KIND: Record<CheckReasonKind, { label: string; tone: PillTone }> = {
  unreadable: { label: "Type it in", tone: "amber" },
  hold: { label: "On hold", tone: "amber" },
  rejected: { label: "Rejected", tone: "red" },
  blocking: { label: "Blocked", tone: "red" },
  coding: { label: "Coding unsure", tone: "violet" },
  requester: { label: "Requester missing", tone: "amber" },
  extraction: { label: "Low-confidence read", tone: "amber" },
  warning: { label: "Warnings", tone: "amber" },
  confirm: { label: "Confirm coding", tone: "teal" },
  ready: { label: "Ready", tone: "emerald" },
};

const FILTERS: { key: string; label: string; kinds: CheckReasonKind[] }[] = [
  { key: "", label: "All", kinds: [] },
  { key: "read", label: "Couldn't read", kinds: ["unreadable", "extraction"] },
  { key: "coding", label: "Coding unsure", kinds: ["coding"] },
  { key: "flags", label: "Blocked / on hold", kinds: ["blocking", "hold", "rejected"] },
  { key: "ready", label: "Nearly ready", kinds: ["confirm", "ready", "requester", "warning"] },
];

export default async function ChecksPage({ searchParams }: PageProps<"/checks">) {
  const viewer = await getViewer();
  if (!canSee(viewer?.role ?? null, "checks")) return <NotForYourRole sectionKey="checks" viewer={viewer} />;
  const [all, params] = await Promise.all([listChecks(viewer!.actor), searchParams]);
  const filter = FILTERS.find((f) => f.key === first(params.show)) ?? FILTERS[0]!;
  const search = first(params.q).trim();
  const sort = parseQueueSort(first(params.sort));
  // Search first (the filter counts below follow it), then the filter, then the order.
  const rows = searchAndSort(all, { search, sort }, (r) => ({
    text: [r.vendorName, r.invoiceNumber, r.invoiceId, r.departmentName],
    vendor: r.vendorName,
    date: r.receivedDate,
    id: r.invoiceId,
  }));
  const shown = filter.kinds.length ? rows.filter((r) => filter.kinds.includes(r.reasons[0]!.kind)) : rows;
  const hrefFor = (show: string) => {
    const next = new URLSearchParams();
    if (show) next.set("show", show);
    if (search) next.set("q", search);
    if (sort !== "default") next.set("sort", sort);
    const qs = next.toString();
    return qs ? `/checks?${qs}` : "/checks";
  };

  return (
    <>
      <PageHeader
        title="Checks"
        description="Every incoming bill stops here before approval. Extraction and coding did what they could; you confirm what they were sure of and decide what they weren't. Most urgent first."
      >
        <Link
          href="/checks/upload"
          className="rounded-lg bg-(--brim-accent) px-4 py-2 text-sm font-semibold text-(--brim-on-accent) hover:bg-(--brim-accent-hover) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--brim-link) focus-visible:ring-offset-2"
        >
          Upload invoices
        </Link>
      </PageHeader>

      <form action="/checks" role="search" className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        {filter.key && <input type="hidden" name="show" value={filter.key} />}
        <label className="min-w-56 flex-1 text-xs font-medium text-slate-600">
          Search
          <input type="search" name="q" defaultValue={search} placeholder="Vendor name, invoice number, id or department" className={`mt-1 ${fieldClass}`} />
        </label>
        <label className="text-xs font-medium text-slate-600">
          Sort by
          <SortSelect value={sort} options={queueSortOptions("Most urgent first", "received")} className={`mt-1 ${fieldClass}`} />
        </label>
        <button type="submit" className="rounded-lg bg-(--brim-accent) px-4 py-2 text-sm font-semibold text-(--brim-on-accent) hover:bg-(--brim-accent-hover)">
          Search
        </button>
        {(search || sort !== "default") && (
          <Link href={filter.key ? `/checks?show=${filter.key}` : "/checks"} className="py-2 text-sm text-slate-500 hover:underline" aria-label="Clear search and sort">
            Clear
          </Link>
        )}
        {search && (
          <p className="w-full text-xs text-slate-500" aria-live="polite">
            {rows.length} of {all.length} bill{all.length === 1 ? "" : "s"} match &ldquo;{search}&rdquo;
          </p>
        )}
      </form>

      <nav className="flex flex-wrap gap-2" aria-label="Filter checks">
        {FILTERS.map((f) => {
          const n = f.kinds.length ? rows.filter((r) => f.kinds.includes(r.reasons[0]!.kind)).length : rows.length;
          const active = f.key === filter.key;
          return (
            <Link
              key={f.key}
              href={hrefFor(f.key)}
              aria-current={active ? "page" : undefined}
              className={`rounded-full px-3 py-1 text-sm font-medium ring-1 ring-inset transition-colors ${active ? "bg-(--brim-frame) text-white ring-(--brim-frame)" : "bg-white text-slate-700 ring-slate-200 hover:ring-slate-300"}`}
            >
              {f.label} <span className="tabular-nums opacity-70">{n}</span>
            </Link>
          );
        })}
      </nav>

      {shown.length === 0 ? (
        <EmptyState title={search ? `No bills match “${search}”${filter.key ? " in this filter" : ""}.` : rows.length ? "Nothing in this filter." : "No bills waiting for checks."}>New bills from the inbox and uploads land here.</EmptyState>
      ) : (
        <Table head={["Why it's here", "Vendor", "Invoice", "Total", "Due", "Lines", "Status"]}>
          {shown.map((r) => {
            const top = r.reasons[0]!;
            return (
              <tr key={r.invoiceId} className="hover:bg-slate-50/70">
                <td className={`${td} max-w-sm`}>
                  <Pill tone={KIND[top.kind].tone}>{KIND[top.kind].label}</Pill>
                  <p className="mt-1 text-xs text-slate-600">{top.label}</p>
                  {r.reasons.length > 1 && <p className="mt-0.5 text-xs text-slate-400">+ {r.reasons.slice(1).map((x) => KIND[x.kind].label.toLowerCase()).join(", ")}</p>}
                </td>
                <td className={td}>
                  <Link href={`/checks/${r.invoiceId}`} className="font-medium text-slate-900 hover:text-(--brim-link) hover:underline">
                    {r.vendorName ?? "Unread document"}
                  </Link>
                  <p className="text-xs text-slate-500">{r.departmentName ?? "Department not set"}</p>
                </td>
                <td className={td}>
                  <p className="font-mono text-xs text-slate-700">{r.invoiceNumber ?? "—"}</p>
                  <p className="text-xs text-slate-500">
                    {r.source === "upload" ? "Uploaded" : "Email"} · <Day value={r.receivedDate} />
                  </p>
                </td>
                <td className={`${td} whitespace-nowrap`}>
                  <Money cents={r.totalCents} currency={r.currency} cadCents={r.totalCadCents} />
                </td>
                <td className={td}>
                  <Day value={r.dueDate} />
                </td>
                <td className={`${td} whitespace-nowrap text-xs text-slate-600`}>
                  {r.lines.total ? (
                    <>
                      {r.lines.confirmed}/{r.lines.total} confirmed
                      {r.lines.unsure ? <span className="block text-violet-700">{r.lines.unsure} unsure</span> : null}
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td className={td}>
                  <InvoiceStatus status={r.status} />
                  {(r.flags.block > 0 || r.flags.warn > 0) && (
                    <p className="mt-1 text-xs">
                      {r.flags.block > 0 && <span className="font-semibold text-red-700">{r.flags.block} blocking</span>}
                      {r.flags.block > 0 && r.flags.warn > 0 && " · "}
                      {r.flags.warn > 0 && <span className="text-amber-700">{r.flags.warn} warn</span>}
                    </p>
                  )}
                </td>
              </tr>
            );
          })}
        </Table>
      )}
    </>
  );
}
