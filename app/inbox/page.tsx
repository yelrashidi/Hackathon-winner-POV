import type { Metadata } from "next";
import Link from "next/link";
import { listInbox } from "@/server/dashboard/records";
import { getViewer } from "@/server/session/current-user";
import { NotForYourRole } from "../_components/NotForYourRole";
import { Card, EmptyState, InvoiceStatus, PageHeader, Pill, type PillTone } from "../_components/ui";
import { first, formatWhen } from "../_lib/format";
import { canSee } from "../_lib/nav";

export const metadata: Metadata = { title: "Inbox" };

const DECISION: Record<string, { label: string; tone: PillTone }> = {
  invoice: { label: "Bill", tone: "emerald" },
  needs_review: { label: "Needs a person", tone: "amber" },
  ignored: { label: "Not a bill", tone: "slate" },
  unclassified: { label: "Not classified", tone: "slate" },
};

export default async function InboxPage({ searchParams }: PageProps<"/inbox">) {
  const viewer = await getViewer();
  if (!canSee(viewer?.role ?? null, "inbox")) return <NotForYourRole sectionKey="inbox" viewer={viewer} />;
  const [rows, params] = await Promise.all([listInbox(viewer!.actor), searchParams]);
  const show = first(params.show);
  const shown = show ? rows.filter((r) => r.decision === show) : rows;
  const count = (d: string) => rows.filter((r) => r.decision === d).length;

  return (
    <>
      <PageHeader
        title="AP inbox"
        description="Every email that reached ap@harborline-logistics, and what intake decided. Only attachments that are bills become invoices; receipts, statements and marketing stay here with the reason. Emails with no attachment are kept for a person, never dropped."
      />
      <nav className="flex flex-wrap gap-2" aria-label="Filter">
        {[
          { key: "", label: "All", n: rows.length },
          { key: "invoice", label: "Bills", n: count("invoice") },
          { key: "needs_review", label: "Needs a person", n: count("needs_review") },
          { key: "ignored", label: "Not a bill", n: count("ignored") },
        ].map((f) => (
          <Link
            key={f.key}
            href={f.key ? `/inbox?show=${f.key}` : "/inbox"}
            aria-current={show === f.key ? "page" : undefined}
            className={`rounded-full px-3 py-1 text-sm font-medium ring-1 ring-inset ${show === f.key ? "bg-(--brim-frame) text-white ring-(--brim-frame)" : "bg-white text-slate-700 ring-slate-200 hover:ring-slate-300"}`}
          >
            {f.label} <span className="tabular-nums opacity-70">{f.n}</span>
          </Link>
        ))}
      </nav>
      {shown.length === 0 ? (
        <EmptyState title="No emails here." />
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-slate-100">
            {shown.map((m) => {
              const d = DECISION[m.decision] ?? DECISION.unclassified!;
              return (
                <li key={m.id} className="px-5 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill tone={d.tone}>{d.label}</Pill>
                    {m.kind && m.kind !== m.decision && <span className="text-xs text-slate-500">{m.kind.replace(/_/g, " ")}</span>}
                    <span className="ml-auto text-xs text-slate-500">
                      {m.id} · {formatWhen(m.receivedAt)}
                    </span>
                  </div>
                  <p className="mt-1 text-sm font-medium text-slate-900">{m.subject || "(no subject)"}</p>
                  <p className="text-xs text-slate-500">
                    From {m.from ?? "unknown"}
                    {m.attachments.length > 0 ? ` · ${m.attachments.length} attachment(s): ${m.attachments.join(", ")}` : " · no attachment"}
                  </p>
                  {m.reason && <p className="mt-1 text-sm text-slate-600">{m.reason}</p>}
                  {m.invoices.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {m.invoices.map((i) => (
                        <Link key={i.invoiceId} href={["ManualEntry", "InReview", "OnHold"].includes(i.status) ? `/checks/${i.invoiceId}` : `/audit/${i.invoiceId}`} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-1 text-xs hover:border-(--brim-accent)">
                          <span className="font-mono">{i.invoiceId}</span> <InvoiceStatus status={i.status} />
                        </Link>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </>
  );
}
