import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { AuditInvoiceDetail } from "@/contracts/audit-view";
import { can } from "@/server/core/authorize";
import { auditDetail } from "@/server/dashboard/audit";
import { stepRoleLabel } from "@/server/dashboard/approvals";
import { getViewer } from "@/server/session/current-user";
import { DocumentViewer, FlagEvidence } from "../../_components/invoice";
import { NotForYourRole } from "../../_components/NotForYourRole";
import { Card, Day, InvoiceStatus, KeyValues, Money, PageHeader, Pill, SeverityBadge, TextLink } from "../../_components/ui";
import { formatWhen } from "../../_lib/format";
import { canSee } from "../../_lib/nav";

export const metadata: Metadata = { title: "Audit trail" };

const RESULT = {
  pass: { label: "Pass", tone: "emerald" as const, icon: "✓" },
  fail: { label: "Fail", tone: "red" as const, icon: "✗" },
  not_applicable: { label: "N/A", tone: "slate" as const, icon: "–" },
};

export default async function AuditDetailPage({ params }: PageProps<"/audit/[invoiceId]">) {
  const viewer = await getViewer();
  if (!canSee(viewer?.role ?? null, "audit")) return <NotForYourRole sectionKey="audit" viewer={viewer} />;
  const { invoiceId } = await params;
  const d = await auditDetail(viewer!.actor, decodeURIComponent(invoiceId));
  if (!d) notFound();
  const inv = d.invoice;
  const canExport = can(viewer!.actor, "audit.export");
  const failed = d.controls.filter((c) => c.result === "fail").length;

  return (
    <>
      <PageHeader
        eyebrow={
          <>
            <TextLink href="/audit">Audit trail</TextLink> · <span className="font-mono">{inv.invoiceId}</span>
          </>
        }
        title={inv.vendor?.legalName ?? inv.vendorNameRaw ?? inv.invoiceId}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <InvoiceStatus status={inv.status} />
            {inv.legacyStatus && inv.legacyStatus !== inv.status && <span className="text-xs">(source system: {inv.legacyStatus})</span>}
            {inv.invoiceNumber && <span className="font-mono text-xs">#{inv.invoiceNumber}</span>}
            <Money cents={inv.totalCents} currency={inv.currency} cadCents={inv.totalCadCents} className="font-medium text-slate-900" />
            <span>· version {inv.version}</span>
            <span>· {inv.source}</span>
          </span>
        }
      >
        <div className="flex flex-wrap gap-3 text-sm">
          {canExport && (
            <a href={`/audit/export?invoiceId=${encodeURIComponent(inv.invoiceId)}`} className="rounded-lg bg-white px-3 py-1.5 font-semibold text-slate-800 shadow-sm ring-1 ring-inset ring-slate-300 hover:bg-slate-50">
              Export this invoice (CSV)
            </a>
          )}
          {canSee(viewer!.role, "checks") && ["ManualEntry", "InReview", "OnHold"].includes(inv.status) && <TextLink href={`/checks/${inv.invoiceId}`}>Open in Checks →</TextLink>}
          {canSee(viewer!.role, "approvals") && inv.status === "PendingApproval" && <TextLink href={`/approvals/${inv.invoiceId}`}>Open in Approvals →</TextLink>}
        </div>
      </PageHeader>

      <Card title="Control checks" description={failed ? `${failed} failed — recomputed from the stored records every time this page opens.` : "Recomputed from the stored records every time this page opens."}>
        <ul className="grid gap-2 md:grid-cols-2">
          {d.controls.map((c) => {
            const r = RESULT[c.result];
            return (
              <li key={c.id} className={`flex items-start gap-3 rounded-lg border px-3 py-2 ${c.result === "fail" ? "border-red-200 bg-red-50/50" : "border-slate-200"}`}>
                <Pill tone={r.tone}>
                  {r.icon} {r.label}
                </Pill>
                <span className="min-w-0 text-sm">
                  <span className="block font-medium text-slate-900">{c.label}</span>
                  <span className="block text-xs text-slate-500">{c.detail}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="min-w-0 space-y-6">
          <DocumentViewer document={d.document ? { documentId: d.document.documentId, fileName: d.document.fileName } : null} height="60vh" />
          {d.document && <p className="-mt-4 break-all px-1 font-mono text-[11px] text-slate-400">sha256 {d.document.sha256}</p>}
          <Card title="Invoice">
            <KeyValues
              items={[
                { label: "Vendor", value: inv.vendor ? `${inv.vendor.legalName} (${inv.vendor.status})` : `Not matched: “${inv.vendorNameRaw ?? "?"}”` },
                { label: "Requester", value: inv.requester?.name ?? "—" },
                { label: "Department", value: inv.departmentId ?? "—" },
                { label: "PO / contract", value: [inv.poId, inv.contractId].filter(Boolean).join(" · ") || "—" },
                { label: "Invoice date", value: <Day value={inv.invoiceDate} /> },
                { label: "Received", value: <Day value={inv.receivedDate} /> },
                { label: "Due", value: <Day value={inv.dueDate} /> },
                { label: "Ship to", value: inv.shipToProvince ?? "—" },
                { label: "Subtotal", value: <Money cents={inv.subtotalCents} currency={inv.currency} /> },
                { label: "Total (CAD)", value: <Money cents={inv.totalCadCents} currency="CAD" />, hint: inv.currency && inv.currency !== "CAD" ? `FX ${inv.fxRate}` : undefined },
              ]}
            />
          </Card>
          <Card title="Validation runs" description="Every run, newest first, with the reference data the verdict used.">
            {d.validationRuns.length === 0 ? (
              <p className="text-sm text-slate-500">None recorded.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {d.validationRuns.map((v, i) => (
                  <li key={i} className="rounded-lg border border-slate-200 px-3 py-2">
                    <p className="text-slate-800">
                      {formatWhen(v.occurredAt)} · version {v.invoiceVersion ?? "?"} {v.blocking && <Pill tone="red">blocking</Pill>}
                    </p>
                    <p className="text-xs text-slate-500">
                      vendor {v.vendorId ?? "unmatched"} · {v.totalCadCents !== null ? <Money cents={v.totalCadCents} currency="CAD" /> : "no CAD total"}
                      {v.fxRate ? ` · FX ${v.fxRate}` : ""}
                      {v.contractId ? ` · contract ${v.contractId}` : ""}
                    </p>
                    {v.flags.length > 0 && <p className="mt-1 text-xs text-slate-600">{v.flags.map((f) => `${f.code} (${f.severity})`).join(", ")}</p>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {d.extraction.raw !== null && d.extraction.raw !== undefined && (
            <Card title="What extraction read" description="Exactly as it came in, before any human edit — the original evidence.">
              <details>
                <summary className="cursor-pointer text-sm font-medium text-(--brim-link)">Show the raw reading</summary>
                <pre className="mt-2 max-h-96 overflow-auto rounded-lg bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-700">{JSON.stringify(d.extraction.raw, null, 2)}</pre>
              </details>
            </Card>
          )}
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
                      {l.codingSource ? ` · ${l.codingSource}` : ""}
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

          <Card title="Flags" description="Every flag ever raised, and who closed it and why.">
            {d.flags.length === 0 ? (
              <p className="text-sm text-slate-500">No flags.</p>
            ) : (
              <ul className="space-y-3">
                {d.flags.map((f) => (
                  <li key={f.flagId} className="text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <SeverityBadge severity={f.severity} />
                      <span className="font-mono text-xs text-slate-500">{f.code}</span>
                      <Pill tone={f.status === "open" ? "red" : f.status === "overridden" ? "amber" : "emerald"}>{f.status}</Pill>
                      <span className="text-xs text-slate-400">{f.source}</span>
                    </div>
                    <p className="mt-1 text-slate-800">{f.message}</p>
                    <FlagEvidence evidence={f.evidence} />
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

          <Approvals d={d} />
          <Payments d={d} />
        </div>
      </div>

      <Card title="Timeline" description="Every audit event for this invoice and its payments, oldest first. Imported events were reconstructed from the dataset's history." padded={false}>
        <ol className="divide-y divide-slate-100">
          {d.timeline.map((e) => (
            <li key={e.id} className="grid gap-1 px-5 py-3 text-sm sm:grid-cols-[11rem_1fr]">
              <span className="text-xs tabular-nums text-slate-500">{formatWhen(e.occurredAt)}</span>
              <div className="min-w-0">
                <p className="text-slate-900">
                  {e.summary} {e.imported && <Pill>imported</Pill>}
                </p>
                <p className="text-xs text-slate-500">
                  <span className="font-mono">{e.action}</span> · {e.actor.name} as {e.actorRoleAtTime}
                  {e.onBehalfOf ? ` on behalf of ${e.onBehalfOf.name}` : ""}
                  {e.reason ? ` · “${e.reason}”` : ""}
                </p>
                {(e.before || e.after) && (
                  <details className="mt-1 text-xs">
                    <summary className="cursor-pointer text-slate-400 hover:text-slate-600">Before / after</summary>
                    <div className="mt-1 grid gap-2 sm:grid-cols-2">
                      <pre className="overflow-auto rounded bg-slate-50 p-2 text-[11px] text-slate-600">{JSON.stringify(e.before, null, 1) ?? "—"}</pre>
                      <pre className="overflow-auto rounded bg-slate-50 p-2 text-[11px] text-slate-600">{JSON.stringify(e.after, null, 1) ?? "—"}</pre>
                    </div>
                  </details>
                )}
              </div>
            </li>
          ))}
        </ol>
      </Card>
    </>
  );
}

function Approvals({ d }: { d: AuditInvoiceDetail }) {
  return (
    <Card title="Approval chain" description="Every routing, with who signed, as what, and on whose behalf.">
      {d.approvals.length === 0 ? (
        <p className="text-sm text-slate-500">Never routed for approval.</p>
      ) : (
        <ul className="space-y-4">
          {d.approvals.map((p) => (
            <li key={p.planId}>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Round {p.attempt} · version {p.invoiceVersion} · {p.outcome} · {formatWhen(p.routedAt)}
              </p>
              <ol className="mt-1.5 space-y-1.5">
                {p.steps.map((s) => {
                  const actedAs = s.actedAs as { fullName?: string; role?: string; approvalLimitCents?: number } | null;
                  return (
                    <li key={s.seq} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-slate-900">
                          {s.seq}. {stepRoleLabel(s.role)}
                        </span>
                        <Pill tone={s.decision === "approved" ? "emerald" : s.decision === "rejected" ? "red" : "violet"}>{s.decision}</Pill>
                        {s.policyId && <span className="font-mono text-xs text-slate-400">{s.policyId}{s.policyVersion ? ` v${s.policyVersion}` : ""}</span>}
                      </div>
                      <p className="mt-0.5 text-xs text-slate-600">
                        {s.actedBy ? (
                          <>
                            {s.actedBy.name}
                            {actedAs?.role ? ` (${actedAs.role}${typeof actedAs.approvalLimitCents === "number" ? `, limit ${(actedAs.approvalLimitCents / 100).toLocaleString("en-CA")} CAD` : ""})` : ""}
                            {s.onBehalfOf ? ` on behalf of ${s.onBehalfOf.name}` : ""} · {formatWhen(s.decidedAt)}
                          </>
                        ) : (
                          <>Assigned to {s.assignedTo?.name ?? "—"}</>
                        )}
                        {s.comment ? ` · “${s.comment}”` : ""}
                      </p>
                    </li>
                  );
                })}
              </ol>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Payments({ d }: { d: AuditInvoiceDetail }) {
  return (
    <Card title="Payments" description="Each attempt, who prepared and released it, and the exact bank-account version it paid to.">
      {d.payments.length === 0 ? (
        <p className="text-sm text-slate-500">No payment yet.</p>
      ) : (
        <ul className="space-y-3">
          {d.payments.map((p) => (
            <li key={p.paymentId} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-slate-500">{p.paymentId}</span>
                <span className="text-xs text-slate-500">attempt {p.attemptNo} · {p.method}</span>
                <Pill tone={p.status === "settled" ? "emerald" : p.status === "failed" ? "red" : p.status === "released" ? "violet" : "sky"}>{p.status}</Pill>
                <Money cents={p.amountCents} currency={p.currency} cadCents={p.amountCadCents} className="ml-auto font-medium" />
              </div>
              <p className="mt-1 text-xs text-slate-600">
                Prepared by {p.preparedBy?.name ?? "—"} · released by {p.releasedBy?.name ?? "—"}
                {p.releasedAt ? ` ${formatWhen(p.releasedAt)}` : ""}
                {p.reference ? ` · ref ${p.reference}` : ""}
                {p.failureCode ? ` · failed: ${p.failureCode}` : ""}
                {p.cancelReason ? ` · cancelled: “${p.cancelReason}”` : ""}
              </p>
              {p.bankAccount && (
                <p className="mt-0.5 text-xs text-slate-500">
                  Paid to account ••••{p.bankAccount.last4} (version {p.bankAccount.version}, {p.bankAccount.status}
                  {p.bankAccount.verifiedBy ? `, verified by ${p.bankAccount.verifiedBy.name}` : ""}
                  {p.bankAccount.requestedBy ? `, change requested by ${p.bankAccount.requestedBy.name}` : ""})
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {d.paymentFlags.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-xs text-slate-600">
          {d.paymentFlags.map((f) => (
            <li key={f.flagId}>
              <Pill tone={f.urgency === "critical" ? "red" : f.urgency === "high" ? "amber" : "slate"}>{f.urgency}</Pill> {f.message}
              {f.clearedAt ? ` — cleared ${f.clearedAutomatically ? "automatically" : `by ${f.clearedBy?.name ?? "—"}`}${f.clearNote ? `: “${f.clearNote}”` : ""}` : " — open"}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
