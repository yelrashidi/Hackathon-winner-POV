import type { Metadata } from "next";
import Link from "next/link";
import { listApprovals, recentDecisions, stepRoleLabel, type ApprovalRow } from "@/server/dashboard/approvals";
import { getViewer } from "@/server/session/current-user";
import { NotForYourRole } from "../_components/NotForYourRole";
import { Card, Day, EmptyState, InvoiceStatus, Money, PageHeader, Pill, Table, td } from "../_components/ui";
import { ago, first, formatWhen } from "../_lib/format";
import { canSee } from "../_lib/nav";

export const metadata: Metadata = { title: "Approvals" };

export default async function ApprovalsPage({ searchParams }: PageProps<"/approvals">) {
  const viewer = await getViewer();
  if (!canSee(viewer?.role ?? null, "approvals")) return <NotForYourRole sectionKey="approvals" viewer={viewer} />;
  const [rows, done, params] = await Promise.all([listApprovals(viewer!.actor), recentDecisions(viewer!.actor), searchParams]);
  const tab = first(params.tab) === "all" ? "all" : first(params.tab) === "done" ? "done" : "mine";
  const mine = rows.filter((r) => r.mine);
  const tabs = [
    { key: "mine", label: "Waiting on you", n: mine.length },
    { key: "all", label: "Everything in approval", n: rows.length },
    { key: "done", label: "You decided", n: done.length },
  ];

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Bills routed to you by the approval policy (by amount in CAD, department, vendor status and flags). Delegated work shows who you are signing for. You never see a bill you requested or submitted as yours to approve."
      />
      <nav className="flex flex-wrap gap-2" aria-label="Approval views">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={t.key === "mine" ? "/approvals" : `/approvals?tab=${t.key}`}
            aria-current={tab === t.key ? "page" : undefined}
            className={`rounded-full px-3 py-1 text-sm font-medium ring-1 ring-inset ${tab === t.key ? "bg-(--brim-frame) text-white ring-(--brim-frame)" : "bg-white text-slate-700 ring-slate-200 hover:ring-slate-300"}`}
          >
            {t.label} <span className="tabular-nums opacity-70">{t.n}</span>
          </Link>
        ))}
      </nav>

      {tab === "done" ? (
        done.length === 0 ? (
          <EmptyState title="You haven't decided anything yet." />
        ) : (
          <Card title="Your recent decisions" padded={false}>
            <ul className="divide-y divide-slate-100">
              {done.map((d) => (
                <li key={`${d.invoiceId}-${d.step}-${d.decidedAt}`}>
                  <Link href={`/approvals/${d.invoiceId}`} className="flex flex-wrap items-center gap-3 px-5 py-3 hover:bg-slate-50">
                    <Pill tone={d.decision === "approved" ? "emerald" : "red"}>{d.decision}</Pill>
                    <span className="min-w-0 flex-1 text-sm">
                      <span className="font-medium text-slate-900">{d.invoice?.vendorName ?? d.invoiceId}</span>
                      <span className="text-slate-500">
                        {" "}
                        · step {d.step} ({stepRoleLabel(d.role)}){d.onBehalfOf ? ` on behalf of ${d.onBehalfOf.name}` : ""}
                      </span>
                    </span>
                    {d.invoice && <InvoiceStatus status={d.invoice.status} />}
                    <span className="text-xs text-slate-500">{formatWhen(d.decidedAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )
      ) : (
        <Queue rows={tab === "mine" ? mine : rows} showWho={tab === "all"} />
      )}
    </>
  );
}

function Queue({ rows, showWho }: { rows: ApprovalRow[]; showWho: boolean }) {
  if (rows.length === 0) return <EmptyState title={showWho ? "Nothing is in approval." : "Nothing is waiting on you."}>Bills reach you after the checks are done and the clerk submits them.</EmptyState>;
  return (
    <Table head={["Vendor", "Amount", "Step", showWho ? "Waiting on" : "Why you", "Waiting", "Due"]}>
      {rows.map((r) => (
        <tr key={r.invoiceId} className="hover:bg-slate-50/70">
          <td className={td}>
            <Link href={`/approvals/${r.invoiceId}`} className="font-medium text-slate-900 hover:text-(--brim-link) hover:underline">
              {r.vendorName ?? r.invoiceId}
            </Link>
            <p className="text-xs text-slate-500">
              {r.departmentName ?? "—"} · requested by {r.requester?.name ?? "—"}
            </p>
            {r.attention > 0 && (
              <p className="mt-1">
                <Pill tone="amber">{r.attention} to acknowledge</Pill>
              </p>
            )}
          </td>
          <td className={`${td} whitespace-nowrap`}>
            <Money cents={r.totalCents} currency={r.currency} cadCents={r.totalCadCents} />
          </td>
          <td className={`${td} whitespace-nowrap text-sm`}>
            {r.step.seq} of {r.step.of}
            <p className="text-xs text-slate-500">{stepRoleLabel(r.step.role)}</p>
          </td>
          <td className={`${td} max-w-xs text-sm`}>
            {showWho ? (
              <>
                {r.waitingOn?.name ?? <span className="text-red-700">Nobody eligible</span>}
                {r.onBehalfOf && <p className="text-xs text-violet-700">for {r.onBehalfOf.name} (on leave)</p>}
              </>
            ) : (
              <>
                <span className="text-slate-700">{r.step.reason}</span>
                {r.onBehalfOf && <p className="text-xs text-violet-700">You sign on behalf of {r.onBehalfOf.name} (on leave)</p>}
              </>
            )}
          </td>
          <td className={`${td} whitespace-nowrap text-xs text-slate-500`}>{ago(r.waitingSince)}</td>
          <td className={td}>
            <Day value={r.dueDate} />
          </td>
        </tr>
      ))}
    </Table>
  );
}
