import type { Metadata } from "next";
import Link from "next/link";
import { parseQueueSort, searchAndSort } from "@/server/dashboard/list-query";
import { getCurrentUser } from "@/server/session/current-user";
import { SortSelect } from "../../_components/SortSelect";
import { queueSortOptions } from "../../_lib/invoice-sort";
import { fieldClass } from "../../_lib/styles";
import { ActionForm, inputClass } from "../_components/ActionForm";
import { NotForYourRole } from "../_components/NotForYourRole";
import { PageHeader } from "../_components/PageHeader";
import { canSeePage, dashboardRole, pageByKey } from "../_lib/access";
import { getDuplicateQueue, type DuplicateReview } from "../_lib/duplicates";
import { formatDate, formatMoney } from "../_lib/format";
import { confirmDuplicateAction, dismissDuplicateAction } from "./actions";

export const metadata: Metadata = { title: "Duplicates" };

const CODE_LABEL: Record<string, string> = {
  DUPLICATE_DOCUMENT: "Same file received twice",
  DUPLICATE_INVOICE: "Same invoice number",
  DUPLICATE_NUMBER_VARIANT: "Re-issued number",
  DUPLICATE_SUSPECTED: "Same amount, days apart",
  ALREADY_PAID_BY_CARD: "Already paid by card",
};

const money = (cents: number | null, currency: string | null) =>
  cents === null ? "—" : `${formatMoney(cents)}${currency && currency !== "CAD" ? ` ${currency}` : ""}`;

type Cell = { label: string; left: string; right: string };

function rows(r: DuplicateReview): Cell[] {
  const me = r.invoice;
  if (r.card) {
    return [
      { label: "Vendor / merchant", left: me.vendorName ?? me.vendorId ?? "Unknown", right: r.card.merchantDescriptor },
      { label: "Amount", left: money(me.totalCents, me.currency), right: money(r.card.amountCents, r.card.currency) },
      { label: "Date", left: `Invoice ${formatDate(me.invoiceDate)}`, right: `Charged ${formatDate(r.card.postedDate)}` },
      { label: "Reference", left: me.invoiceNumber ?? "—", right: `${r.card.id}${r.card.cardholderId ? ` · cardholder ${r.card.cardholderId}` : ""}` },
      { label: "Status", left: me.status, right: r.card.source === "employee_card" ? "Employee card" : r.card.source },
    ];
  }
  const o = r.related;
  return [
    { label: "Invoice", left: me.invoiceId, right: o?.invoiceId ?? "—" },
    { label: "Vendor", left: me.vendorName ?? me.vendorId ?? "Unknown", right: o ? (o.vendorName ?? o.vendorId ?? "Unknown") : "—" },
    { label: "Number", left: me.invoiceNumber ?? "—", right: o?.invoiceNumber ?? "—" },
    { label: "Invoice date", left: formatDate(me.invoiceDate), right: formatDate(o?.invoiceDate ?? null) },
    { label: "Received", left: formatDate(me.receivedDate), right: formatDate(o?.receivedDate ?? null) },
    { label: "Amount", left: money(me.totalCents, me.currency), right: o ? money(o.totalCents, o.currency) : "—" },
    { label: "Status", left: me.status, right: o ? o.status : "—" },
  ];
}

function Comparison({ r }: { r: DuplicateReview }) {
  return (
    <table className="w-full table-fixed text-sm">
      <thead>
        <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
          <th className="w-32 pb-1 font-medium" />
          <th className="pb-1 font-medium">This invoice</th>
          <th className="pb-1 font-medium">{r.card ? "Card charge" : "Earlier invoice"}</th>
        </tr>
      </thead>
      <tbody>
        {rows(r).map((c) => {
          const same = c.left === c.right && c.left !== "—";
          return (
            <tr key={c.label} className="border-t border-slate-100">
              <td className="py-1.5 pr-2 text-xs text-slate-500">{c.label}</td>
              <td className={`py-1.5 pr-2 break-words ${same ? "font-semibold text-amber-800" : "text-slate-800"}`}>{c.left}</td>
              <td className={`py-1.5 break-words ${same ? "font-semibold text-amber-800" : "text-slate-800"}`}>{c.right}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ReviewCard({ r, act }: { r: DuplicateReview; act: boolean }) {
  const block = r.severity === "block";
  return (
    <li className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${block ? "bg-rose-50 text-rose-700 ring-rose-200" : "bg-amber-50 text-amber-800 ring-amber-200"}`}>
          {block ? "Blocks approval" : "Check"}
        </span>
        <span className="text-sm font-semibold text-(--brim-heading)">{CODE_LABEL[r.code] ?? r.code}</span>
        <code className="text-[11px] text-slate-400">{r.code}</code>
      </div>
      <p className="mt-2 text-sm text-slate-700">{r.message}</p>
      <div className="mt-4">
        <Comparison r={r} />
      </div>

      {r.splitFacts.length > 0 && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">If it is not a duplicate: possible split</p>
          <ul className="mt-1 space-y-1">
            {r.splitFacts.map((s) => (
              <li key={s.flagId} className="text-sm text-amber-900">
                {s.message}{" "}
                <code className="text-[11px] text-amber-700">
                  {s.code} · {s.source}
                </code>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-amber-700">
            Confirming the duplicate clears this. Marking it &ldquo;not a duplicate&rdquo; leaves it on the invoice as an open warning.
          </p>
        </div>
      )}

      {act ? (
        <div className="mt-4 flex flex-wrap items-start gap-6 border-t border-slate-100 pt-4">
          {r.canConfirm ? (
            <ActionForm action={confirmDuplicateAction} label={r.confirmLabel} tone="danger" hidden={{ flagId: String(r.flagId) }}>
              <input name="note" required placeholder="Why it is the same bill" aria-label="Why it is the same bill" className={`${inputClass} w-56`} />
            </ActionForm>
          ) : (
            <p className="max-w-xs text-xs text-slate-500">
              This invoice is <strong>{r.invoice.status}</strong>, so it can no longer be voided here. Its open flag still stops the payment from being released.
            </p>
          )}
          <ActionForm action={dismissDuplicateAction} label="Not a duplicate" tone="quiet" hidden={{ flagId: String(r.flagId) }}>
            <input name="note" required placeholder="Why it is a different bill" aria-label="Why it is a different bill" className={`${inputClass} w-56`} />
          </ActionForm>
        </div>
      ) : (
        <p className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">View only: AP Clerks and Controllers decide duplicates.</p>
      )}
    </li>
  );
}

export default async function DuplicatesPage({ searchParams }: PageProps<"/payments/duplicates">) {
  const [user, queue, params] = await Promise.all([getCurrentUser(), getDuplicateQueue(), searchParams]);
  const role = dashboardRole(user);
  if (!canSeePage(role, "duplicates")) return <NotForYourRole page={pageByKey("duplicates")} user={user} />;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));
  const search = one(params.q).trim();
  const sort = parseQueueSort(one(params.sort));
  // Either side of the pair counts: this invoice, the earlier one, or the card charge.
  const reviews = queue.ok
    ? searchAndSort(queue.reviews, { search, sort }, (r) => ({
        text: [r.invoice.vendorName, r.invoice.invoiceNumber, r.invoice.invoiceId, r.related?.vendorName, r.related?.invoiceNumber, r.related?.invoiceId, r.card?.merchantDescriptor, r.card?.id],
        vendor: r.invoice.vendorName,
        date: r.invoice.invoiceDate,
        id: `${r.invoice.invoiceId}#${String(r.flagId).padStart(10, "0")}`,
      }))
    : [];

  return (
    <>
      <PageHeader
        title="Possible duplicates"
        description="Invoices that look like a bill we already have, or one already paid by card. Nothing is voided automatically: compare the two records and decide. Every decision needs a reason and is kept in the audit trail."
      />
      {!queue.ok ? (
        <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
          <p className="font-semibold">The invoice database is not reachable, so duplicates can&apos;t be shown.</p>
          <p className="mt-1">
            Start it with <code>npm run db:up</code>, then <code>npm run db:migrate</code> and <code>npm run db:seed</code>, and set <code>DATABASE_URL</code>.
          </p>
          <p className="mt-2 text-xs text-amber-700">{queue.reason}</p>
        </div>
      ) : (
        <form action="/payments/duplicates" role="search" className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <label className="min-w-56 flex-1 text-xs font-medium text-slate-600">
            Search
            <input type="search" name="q" defaultValue={search} placeholder="Vendor, invoice number, id or card merchant (either side)" className={`mt-1 ${fieldClass}`} />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Sort by
            <SortSelect value={sort} options={queueSortOptions("Most recently flagged")} className={`mt-1 ${fieldClass}`} />
          </label>
          <button type="submit" className="rounded-lg bg-(--brim-accent) px-4 py-2 text-sm font-semibold text-(--brim-on-accent) hover:bg-(--brim-accent-hover)">
            Search
          </button>
          {(search || sort !== "default") && (
            <Link href="/payments/duplicates" className="py-2 text-sm text-slate-500 hover:underline">
              Clear
            </Link>
          )}
          <p className="w-full text-xs text-slate-500" aria-live="polite">
            {search ? `${reviews.length} of ${queue.reviews.length} possible duplicates match “${search}”` : `${queue.reviews.length} possible duplicate${queue.reviews.length === 1 ? "" : "s"} waiting`}
          </p>
        </form>
      )}
      {!queue.ok ? null : reviews.length === 0 && search ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          No possible duplicates match &ldquo;{search}&rdquo;. <Link href="/payments/duplicates" className="font-medium text-(--brim-link) underline">Clear the search</Link>
        </div>
      ) : queue.reviews.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          No possible duplicates waiting. <Link href="/payments" className="font-medium text-(--brim-link) underline">Back to overview</Link>
        </div>
      ) : (
        <ul className="space-y-4">
          {reviews.map((r) => (
            // AP Clerks and Controllers decide duplicates (docs/architecture/5-duplicates.md). Not canAct():
            // that is false for the Controller (Admin/CFO) and hid their buttons.
            <ReviewCard key={r.flagId} r={r} act={role === "clerk" || role === "controller"} />
          ))}
        </ul>
      )}
    </>
  );
}
