import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getApproval } from "@/server/dashboard/approvals";
import { getViewer } from "@/server/session/current-user";
import { ApprovalRoute, DocumentViewer, JournalTable } from "../../_components/invoice";
import { NotForYourRole } from "../../_components/NotForYourRole";
import { Card, ConfidenceBadge, Day, InvoiceStatus, KeyValues, Money, Notice, PageHeader, Pill, SeverityBadge, TextLink } from "../../_components/ui";
import { canSee } from "../../_lib/nav";
import { InvoiceProgress } from "../../_components/InvoiceProgress";
import { DecisionForm } from "./DecisionForm";

export const metadata: Metadata = { title: "Approve invoice" };

export default async function ApprovalPage({ params }: PageProps<"/approvals/[invoiceId]">) {
  const viewer = await getViewer();
  if (!canSee(viewer?.role ?? null, "approvals") && !canSee(viewer?.role ?? null, "checks")) return <NotForYourRole sectionKey="approvals" viewer={viewer} />;
  const { invoiceId } = await params;
  const d = await getApproval(viewer!.actor, decodeURIComponent(invoiceId));
  if (!d) notFound();
  const inv = d.invoice;
  const openFlags = d.flags.filter((f) => f.status !== "resolved");

  return (
    <>
      <PageHeader
        eyebrow={
          <>
            <TextLink href="/approvals">Approvals</TextLink> · <span className="font-mono">{inv.invoiceId}</span>
          </>
        }
        title={inv.vendorName ?? inv.invoiceId}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <InvoiceStatus status={inv.status} />
            {inv.invoiceNumber && <span className="font-mono text-xs">#{inv.invoiceNumber}</span>}
            <Money cents={inv.totalCents} currency={inv.currency} cadCents={inv.totalCadCents} className="font-medium text-slate-900" />
            {inv.isCreditNote && <Pill tone="sky">Credit note</Pill>}
          </span>
        }
      >
        {canSee(viewer!.role, "audit") ? <TextLink href={`/audit/${inv.invoiceId}`}>Audit trail →</TextLink> : <TextLink href={`/invoices/${inv.invoiceId}`}>Invoice record →</TextLink>}
      </PageHeader>

      <InvoiceProgress actor={viewer!.actor} invoiceId={inv.invoiceId} />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="xl:sticky xl:top-20 xl:self-start">
          <DocumentViewer document={d.document} height="70vh" />
        </div>
        <div className="min-w-0 space-y-6">
          {d.you?.canAct ? (
            <Card title="Your decision" description="Approving confirms the amount, the payee and the coding below.">
              <DecisionForm invoiceId={inv.invoiceId} attention={d.plan?.attention ?? []} onBehalfOf={d.you.onBehalfOf?.name ?? null} />
            </Card>
          ) : inv.status === "PendingApproval" ? (
            <Notice tone="info" title={d.waitingOn ? `Waiting on ${d.waitingOn.name}` : "Nobody can approve this step yet"}>
              {d.you && !d.you.canAct ? d.you.reason : "You can follow it here; you are not an approver on this step."}
            </Notice>
          ) : (
            <Notice tone={inv.status === "Approved" || inv.status === "Paid" || inv.status === "PaymentScheduled" ? "success" : "info"} title={`This invoice is ${inv.status.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()}`}>
              {inv.status === "InReview" ? "It is back in Checks (rejected or edited); it will be routed again when it is resubmitted." : "There is nothing to decide."}
            </Notice>
          )}

          {d.plan && <ApprovalRoute plan={d.plan} names={d.names} current={d.waitingOn} />}

          <Card title="What is being approved">
            <KeyValues
              columns={3}
              items={[
                { label: "Vendor", value: inv.vendorId ? <TextLink href={`/vendors/${inv.vendorId}`}>{inv.vendorName}</TextLink> : (inv.vendorName ?? "—"), hint: inv.vendorStatus && inv.vendorStatus !== "active" ? `Vendor is ${inv.vendorStatus.replace("_", " ")}` : undefined },
                { label: "Requested by", value: inv.requester?.name ?? "—" },
                { label: "Department", value: inv.departmentName ?? "—" },
                { label: "Invoice date", value: <Day value={inv.invoiceDate} /> },
                { label: "Due", value: <Day value={inv.dueDate} /> },
                { label: "PO", value: inv.poId ?? "—" },
                { label: "Subtotal", value: <Money cents={inv.subtotalCents} currency={inv.currency} /> },
                { label: "Total", value: <Money cents={inv.totalCents} currency={inv.currency} /> },
                { label: "In CAD", value: inv.currency === "CAD" ? "same" : <><Money cents={inv.totalCadCents} currency="CAD" /> at {inv.fxRate}</> },
              ]}
            />
          </Card>

          <Card title="Coding" description="What will be posted: confirmed by a person in Checks." padded={false}>
            <ul className="divide-y divide-slate-100">
              {d.lines.map((l) => (
                <li key={l.lineNo} className="flex flex-wrap items-start gap-3 px-5 py-3 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="block text-slate-900">
                      {l.lineNo}. {l.description}
                    </span>
                    <span className="block text-xs text-slate-500">
                      {l.glAccount ?? "—"} · {l.departmentId ?? "—"} · {l.source === "suggested" ? "suggested" : `${l.source} by ${d.names[l.codedBy ?? ""]?.name ?? l.codedBy ?? "—"}`} <ConfidenceBadge confidence={l.account.confidence} />
                    </span>
                  </span>
                  <Money cents={l.amountCents} className="font-medium" />
                </li>
              ))}
            </ul>
            {d.journal && (
              <div className="border-t border-slate-100 px-5 py-4">
                <JournalTable journal={d.journal} />
              </div>
            )}
          </Card>

          <Card title="Flags" description={openFlags.length ? "Open or overridden flags — what you are accepting by approving." : "Nothing open."}>
            {d.flags.length === 0 ? (
              <p className="text-sm text-slate-500">No flags.</p>
            ) : (
              <ul className="space-y-2">
                {d.flags.map((f, i) => (
                  <li key={i} className={`text-sm ${f.status === "resolved" ? "opacity-60" : ""}`}>
                    <span className="mr-2 inline-flex gap-1 align-middle">
                      <SeverityBadge severity={f.severity} />
                      {f.status !== "open" && <Pill tone={f.status === "overridden" ? "amber" : "emerald"}>{f.status}</Pill>}
                    </span>
                    <span className="text-slate-800">{f.message}</span>
                    {f.note && (
                      <span className="block text-xs text-slate-500">
                        {f.status} by {f.resolvedBy?.name ?? "—"}: “{f.note}”
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {d.history.length > 1 && (
            <Card title="Earlier rounds" description="Every submit is a new plan; rejected or edited rounds stay on record.">
              <ul className="space-y-1 text-sm text-slate-600">
                {d.history.slice(0, -1).map((p) => (
                  <li key={p.planId}>
                    Version {p.invoiceVersion} · {p.outcome} · {p.steps.map((s) => `${s.seq}: ${s.decision}${s.actedBy ? ` (${d.names[s.actedBy]?.name ?? s.actedBy})` : ""}`).join(", ") || p.holdReasons.map((h) => h.message).join(" · ")}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
