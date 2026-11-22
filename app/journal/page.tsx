import type { Metadata } from "next";
import Link from "next/link";
import { journalExports, previewJournal, type JournalEntryOut } from "@/server/features/journal";
import { getViewer } from "@/server/session/current-user";
import { NotForYourRole } from "../_components/NotForYourRole";
import { Card, EmptyState, Money, Notice, PageHeader, Pill, StatCard, Table, td } from "../_components/ui";
import { first, formatCents, formatDay, formatWhen, todayIso } from "../_lib/format";
import { canSee } from "../_lib/nav";
import { fieldClass } from "../_lib/styles";
import { DownloadForm } from "./DownloadForm";

export const metadata: Metadata = { title: "Journal export" };

const PREVIEW_ENTRIES = 20;
const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

/** First and last day of the month `offset` months from today's (Toronto) month. */
function month(offset: number): { from: string; to: string; label: string } {
  const [y, m] = todayIso().split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + offset, 1));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return { from: d.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10), label: d.toLocaleString("en-CA", { month: "long", year: "numeric", timeZone: "UTC" }) };
}

export default async function JournalPage({ searchParams }: PageProps<"/journal">) {
  const viewer = await getViewer();
  if (!canSee(viewer?.role ?? null, "journal")) return <NotForYourRole sectionKey="journal" viewer={viewer} />;
  const params = await searchParams;
  // A submitted form sends only the boxes that are ticked; the first visit uses the defaults.
  const submitted = first(params.f) === "1";
  const box = (k: string) => (submitted ? first(params[k]) === "1" : true);
  const query = {
    from: isDay(first(params.from)) ? first(params.from) : undefined,
    to: isDay(first(params.to)) ? first(params.to) : undefined,
    bills: box("bills"),
    payments: box("payments"),
    onlyNew: box("onlyNew"),
  };
  const [p, history] = await Promise.all([previewJournal(viewer!.actor, query), journalExports(viewer!.actor, { limit: 8 })]);
  const error = first(params.error);
  const hidden = { from: query.from ?? "", to: query.to ?? "", bills: query.bills ? "1" : "", payments: query.payments ? "1" : "", onlyNew: query.onlyNew ? "1" : "" };
  const quick = [month(0), month(-1)];
  const link = (q: Record<string, string | undefined>) => `/journal?${new URLSearchParams(Object.entries({ f: "1", bills: "1", payments: "1", onlyNew: "1", ...q }).filter(([, v]) => v) as [string, string][]).toString()}`;

  return (
    <>
      <PageHeader
        title="Journal export"
        description="Approved bills and settled payments as journal entries for Harborline's accounting system, so nobody retypes them. Every entry balances; amounts are in CAD with the original currency and rate kept on each line."
      >
        <DownloadForm hidden={hidden} disabled={p.entries.length === 0 || !p.totals.balanced} label={`Download CSV (${p.entries.length} ${p.entries.length === 1 ? "entry" : "entries"})`} />
      </PageHeader>

      {error && <Notice tone="warn" title="Nothing was exported">{error}</Notice>}

      <form action="/journal" className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-6">
        <input type="hidden" name="f" value="1" />
        <label className="text-xs font-medium text-slate-600">
          From (entry date)
          <input type="date" name="from" defaultValue={query.from ?? ""} className={`mt-1 ${fieldClass}`} />
        </label>
        <label className="text-xs font-medium text-slate-600">
          To
          <input type="date" name="to" defaultValue={query.to ?? ""} className={`mt-1 ${fieldClass}`} />
        </label>
        <div className="flex flex-col justify-end gap-1.5 text-sm text-slate-700 lg:col-span-2">
          <label className="flex items-center gap-2">
            <input type="checkbox" name="bills" value="1" defaultChecked={query.bills} className="accent-(--brim-link)" /> Bills (approved, by invoice date)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="payments" value="1" defaultChecked={query.payments} className="accent-(--brim-link)" /> Payments (settled, by paid date)
          </label>
        </div>
        <div className="flex flex-col justify-end gap-1.5 text-sm text-slate-700 lg:col-span-2">
          <label className="flex items-center gap-2">
            <input type="checkbox" name="onlyNew" value="1" defaultChecked={query.onlyNew} className="accent-(--brim-link)" /> Only entries not exported before
          </label>
          <span className="text-xs text-slate-500">Untick to download a period again (e.g. a lost file).</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:col-span-2 lg:col-span-6">
          <button type="submit" className="rounded-lg bg-white px-4 py-1.5 text-sm font-semibold text-slate-800 ring-1 ring-inset ring-slate-300 hover:bg-slate-50">
            Preview
          </button>
          <span className="text-xs text-slate-500">Quick:</span>
          {quick.map((q) => (
            <Link key={q.from} href={link({ from: q.from, to: q.to })} className="rounded-full px-3 py-1 text-xs font-medium text-(--brim-link) ring-1 ring-inset ring-slate-200 hover:ring-(--brim-accent)">
              {q.label}
            </Link>
          ))}
          <Link href={link({})} className="rounded-full px-3 py-1 text-xs font-medium text-(--brim-link) ring-1 ring-inset ring-slate-200 hover:ring-(--brim-accent)">
            Everything not exported yet
          </Link>
        </div>
      </form>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Bills" value={p.totals.bills} hint="Dr expenses + tax · Cr Accounts Payable" />
        <StatCard label="Payments" value={p.totals.payments} hint="Dr Accounts Payable · Cr bank / card" />
        <StatCard label="Debits = credits" value={formatCents(p.totals.debitCents)} hint={p.totals.balanced ? `✓ Balanced · ${p.totals.lines} lines` : "✗ Does not balance"} tone={p.totals.balanced ? "good" : "alert"} />
        <StatCard label="Left out" value={p.excluded.length + p.alreadyExported} hint={`${p.alreadyExported} already exported · ${p.excluded.length} can't be posted`} tone={p.excluded.length ? "alert" : "default"} />
      </div>

      {p.excluded.length > 0 && (
        <Card title="Can't be posted" description="Left out of the file so nothing is exported half-right. Fix them in Checks; they are picked up by the next export.">
          <ul className="space-y-1 text-sm">
            {p.excluded.map((e) => (
              <li key={`${e.entryType}-${e.id}`}>
                <Pill tone="amber">{e.entryType}</Pill> <span className="font-mono text-xs">{e.id}</span> {e.vendorName} — {e.reason}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {p.entries.length === 0 ? (
        <EmptyState title={p.alreadyExported ? "Everything here has already been exported." : "No approved bills or settled payments in this selection."}>
          {p.alreadyExported ? "Untick “Only entries not exported before” to download it again." : "Pick another period."}
        </EmptyState>
      ) : (
        <Card title="Preview" description={p.entries.length > PREVIEW_ENTRIES ? `The first ${PREVIEW_ENTRIES} of ${p.entries.length} entries; the file has all of them.` : "Exactly what the file contains."} padded={false}>
          <Table head={["Date", "Entry", "Account", "Dept", "Description", "Debit (CAD)", "Credit (CAD)"]}>
            {p.entries.slice(0, PREVIEW_ENTRIES).map((e) => (
              <EntryRows key={e.entryId} entry={e} />
            ))}
          </Table>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Accounts used" description="Expense, tax, Accounts Payable (2100) and FX (7020) come from the chart of accounts. These three are not in Harborline's chart, so they are mapped — match them to the accounting system before importing.">
          <ul className="space-y-1 text-sm">
            {Object.values(p.accounts).map((a) => (
              <li key={a.code}>
                <span className="font-mono">{a.code}</span> {a.name}
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Export history" description="Each download is recorded in the audit trail with exactly which bills and payments it contained." padded={false}>
          {history.length === 0 ? (
            <p className="px-5 py-4 text-sm text-slate-500">Nothing exported yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {history.map((h) => (
                <li key={h.exportId} className="px-5 py-2.5 text-sm">
                  <p className="text-slate-900">
                    <span className="font-mono text-xs">{h.exportId}</span> · {h.bills} bills, {h.payments} payments · <Money cents={h.debitCents} currency="CAD" />
                  </p>
                  <p className="text-xs text-slate-500">
                    {h.by.name} · {formatWhen(h.at)} · {h.from || h.to ? `${formatDay(h.from)} → ${formatDay(h.to)}` : "all dates"}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

function EntryRows({ entry }: { entry: JournalEntryOut }) {
  return (
    <>
      {entry.lines.map((l, i) => (
        <tr key={i} className={i === 0 ? "border-t-2 border-slate-200" : ""}>
          <td className={`${td} whitespace-nowrap text-xs text-slate-500`}>{i === 0 ? formatDay(entry.entryDate) : ""}</td>
          <td className={`${td} whitespace-nowrap text-xs`}>
            {i === 0 && (
              <>
                <Pill tone={entry.entryType === "bill" ? "blue" : "emerald"}>{entry.entryType}</Pill>
                <Link href={`/audit/${entry.invoiceId}`} className="ml-1 font-mono text-(--brim-link) hover:underline">
                  {entry.paymentId ?? entry.invoiceId}
                </Link>
              </>
            )}
          </td>
          <td className={`${td} whitespace-nowrap text-xs`}>
            <span className="font-mono">{l.glAccount}</span> <span className="text-slate-500">{l.accountName}</span>
          </td>
          <td className={`${td} text-xs text-slate-500`}>{l.departmentId ?? ""}</td>
          <td className={`${td} max-w-sm text-xs text-slate-700`}>
            {l.description}
            {l.currency !== "CAD" && l.amountOriginalCents !== 0 && (
              <span className="text-slate-400">
                {" "}
                ({formatCents(Math.abs(l.amountOriginalCents))} {l.currency} @ {l.fxRate})
              </span>
            )}
          </td>
          <td className={`${td} whitespace-nowrap text-right tabular-nums`}>{l.debitCents ? formatCents(l.debitCents) : ""}</td>
          <td className={`${td} whitespace-nowrap text-right tabular-nums`}>{l.creditCents ? formatCents(l.creditCents) : ""}</td>
        </tr>
      ))}
    </>
  );
}
