import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Forbidden } from "@/server/core/authorize";
import { stepRoleLabel } from "@/server/dashboard/approvals";
import { getInvoiceRecord } from "@/server/features/invoices";
import { getViewer } from "@/server/session/current-user";
import { DocumentViewer } from "../../_components/invoice";
import { NotForYourRole } from "../../_components/NotForYourRole";
import { WhoDidWhat } from "../../_components/WhoDidWhat";
import { Card, Day, InvoiceStatus, KeyValues, Money, Notice, PageHeader, Pill, SeverityBadge, TextLink } from "../../_components/ui";
import { formatWhen } from "../../_lib/format";
import { canSee } from "../../_lib/nav";

export const metadata: Metadata = { title: "Invoice" };

// One invoice, read-only: who did what, the document, the coding, the flags and the payment
// (feature 6: "invoice, coding and approval history on one screen"). Scoped like the list.
// The full audit log (every event, before/after, control checks) is /audit, for the Auditor and Admin.
export default async function InvoiceRecordPage({ params }: PageProps<"/invoices/[invoiceId]">) {
  const viewer = await getViewer();
  if (!canSee(viewer?.role ?? null, "invoices")) return <NotForYourRole sectionKey="invoices" viewer={viewer} />;
  const id = decodeURIComponent((await params).invoiceId);
  let d;
  try {
    d = await getInvoiceRecord(viewer!.actor, id, { stepLabel: stepRoleLabel });
  } catch (err) {
    if (err instanceof Forbidden) {
      return (
        <Notice tone="warning" title="Not one of your invoices">
          {err.reason} <TextLink href="/invoices">Back to your invoices</TextLink>
        </Notice>
      );
    }
    throw err;
  }
  if (!d) notFound();
  const inv = d.invoice;
  const open = ["ManualEntry", "InReview", "OnHold"].includes(inv.status);

  return (
    <>
      <PageHeader
        eyebrow={
          <>
            <TextLink href="/invoices">Invoices</TextLink> · <span className="font-mono">{inv.invoiceId}</span>
          </>
        }
        title={inv.vendor?.legalName ?? inv.vendorNameRaw ?? inv.invoiceId}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <InvoiceStatus status={inv.status} />
            {inv.invoiceNumber && <span className="font-mono text-xs">#{inv.invoiceNumber}</span>}
            <Money cents={inv.totalCents} currency={inv.currency} cadCents={inv.totalCadCents} className="font-medium text-slate-900" />
          </span>
        }
      >
        <div className="flex flex-wrap gap-3 text-sm">
          {canSee(viewer!.role, "checks") && open && <TextLink href={`/checks/${inv.invoiceId}`}>Open in Checks →</TextLink>}
          {canSee(viewer!.role, "approvals") && inv.status === "PendingApproval" && <TextLink href={`/approvals/${inv.invoiceId}`}>Open in Approvals →</TextLink>}
          {canSee(viewer!.role, "audit") && <TextLink href={`/audit/${inv.invoiceId}`}>Full audit trail →</TextLink>}
        </div>
      </PageHeader>

      <WhoDidWhat steps={d.chain} />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="min-w-0 space-y-6">
          <DocumentViewer document={d.document ? { documentId: d.document.documentId, fileName: d.document.fileName } : null} height="60vh" />
          <Card title="Invoice">
            <KeyValues
              items={[
                { label: "Vendor", value: inv.vendor ? `${inv.vendor.legalName} (${inv.vendor.status})` : `Not matched: “${inv.vendorNameRaw ?? "?"}”` },
                { label: "Requester", value: inv.requester?.name ?? "—" },
                { label: "Department", value: inv.departmentId ?? "—" },
                { label: "PO / contract", value: [inv.poId, inv.contractId].filter(Boolean).join(" · ") || "—" },
                { label: "Invoice date", value: <Day value={inv.invoiceDate} /> },
                { label: "Due", value: <Day value={inv.dueDate} /> },
                { label: "Subtotal", value: <Money cents={inv.subtotalCents} currency={inv.currency} /> },
                { label: "Total (CAD)", value: <Money cents={inv.totalCadCents} currency="CAD" />, hint: inv.currency && inv.currency !== "CAD" ? `FX ${inv.fxRate}` : undefined },
              ]}
            />
          </Card>
        </div>

        <div className="min-w-0 space-y-6">
          <Card title="Lines and GL coding" padded={false}>
            <ul className="divide-y divide-slate-100">
              {d.lines.map((l) => (
                <li key={l.lineNo} className="flex flex-wrap items-start gap-3 px-5 py-2.5 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="block text-slate-900">
                      {l.lineNo}. {l.description}
                    </span>
                    <span className="block text-xs text-slate-500">
                      {l.glAccount ? `${l.glAccount.code} ${l.glAccount.name ?? ""}` : "not coded"} · {l.departmentId ?? "—"}
                    </span>
                  </span>
                  <Money cents={l.amountCents} />
                </li>
              ))}
              {d.taxes.map((t, i) => (
                <li key={`t${i}`} className="flex items-center gap-3 px-5 py-2 text-xs text-slate-500">
                  <span className="flex-1">
                    Tax {t.code ?? "?"} {t.label ? `· ${t.label}` : ""}
                  </span>
                  <Money cents={t.amountCents} />
                </li>
              ))}
            </ul>
          </Card>

          <Card title="Flags" description="What the checks found, and how each was closed.">
            {d.flags.length === 0 ? (
              <p className="text-sm text-slate-500">No flags.</p>
            ) : (
              <ul className="space-y-2">
                {d.flags.map((f) => (
                  <li key={f.flagId} className="text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <SeverityBadge severity={f.severity} />
                      <span className="font-mono text-xs text-slate-500">{f.code}</span>
                      <Pill tone={f.status === "open" ? "red" : f.status === "overridden" ? "amber" : "emerald"}>{f.status}</Pill>
                    </div>
                    <p className="mt-0.5 text-slate-800">{f.message}</p>
                    {f.status !== "open" && (
                      <p className="text-xs text-slate-500">
                        {f.resolvedBy?.name ?? "System"} · {formatWhen(f.resolvedAt)}
                        {f.resolutionNote ? ` · “${f.resolutionNote}”` : ""}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Payment">
            {d.payments.length === 0 ? (
              <p className="text-sm text-slate-500">No payment yet.</p>
            ) : (
              <ul className="space-y-2">
                {d.payments.map((p) => (
                  <li key={p.paymentId} className="text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-slate-500">{p.paymentId}</span>
                      <Pill tone={p.status === "settled" ? "emerald" : p.status === "failed" ? "red" : "sky"}>{p.status}</Pill>
                      <Money cents={p.amountCents} currency={p.currency} cadCents={p.amountCadCents} className="ml-auto font-medium" />
                    </div>
                    <p className="text-xs text-slate-500">
                      Scheduled <Day value={p.scheduledDate} />
                      {p.paidDate ? (
                        <>
                          {" "}
                          · paid <Day value={p.paidDate} />
                        </>
                      ) : null}
                      {p.bankAccount ? ` · to account ••••${p.bankAccount.last4}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
