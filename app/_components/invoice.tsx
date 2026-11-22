import type { ApprovalPlan } from "@/contracts/approvals";
import type { JournalPreview } from "@/contracts/coding";
import type { PersonRef } from "@/server/dashboard/shared";
import { stepRoleLabel } from "@/server/dashboard/approvals";
import { formatCents, formatWhen } from "../_lib/format";
import { Card, Money, Pill, SeverityBadge } from "./ui";

// Pieces of an invoice that several screens show the same way: the original document, the approval
// route, the journal entry, a flag.

export function DocumentViewer({ document, height = "75vh" }: { document: { documentId: string; fileName: string | null; mime?: string | null } | null; height?: string }) {
  if (!document) {
    return (
      <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white text-sm text-slate-500">
        No original file is linked to this invoice.
      </div>
    );
  }
  const src = `/documents/${document.documentId}`;
  const isImage = document.mime?.startsWith("image/") || /\.(png|jpe?g)$/i.test(document.fileName ?? "");
  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-2.5">
        <span className="truncate text-sm font-semibold text-slate-900">{document.fileName ?? "Original document"}</span>
        <a href={src} target="_blank" rel="noreferrer" className="shrink-0 text-xs font-medium text-(--brim-link) hover:underline">
          Open in new tab ↗
        </a>
      </header>
      {isImage ? (
        // eslint-disable-next-line @next/next/no-img-element -- the original scan, served privately
        <img src={src} alt={document.fileName ?? "Original document"} className="w-full object-contain" style={{ maxHeight: height }} />
      ) : (
        <iframe src={src} title={document.fileName ?? "Original document"} className="w-full" style={{ height }} />
      )}
    </section>
  );
}

const DECISION: Record<string, { label: string; tone: "slate" | "emerald" | "red" | "violet" }> = {
  pending: { label: "Waiting", tone: "violet" },
  approved: { label: "Approved", tone: "emerald" },
  rejected: { label: "Rejected", tone: "red" },
};

/** The approval chain, step by step: who, why, delegation, and what each person decided. */
export function ApprovalRoute({ plan, names, current, title = "Approval route", preview = false }: { plan: ApprovalPlan; names: Record<string, PersonRef>; current?: PersonRef | null; title?: string; preview?: boolean }) {
  const name = (id: string | null | undefined) => (id ? (names[id]?.name ?? id) : "—");
  const routing = plan.routingCadCents;
  return (
    <Card
      title={title}
      description={
        preview
          ? `What approvals would do if this were submitted now (routing amount ${formatCents(routing)} CAD). Nothing is saved until you submit.`
          : `Routed ${formatWhen(plan.routedAt)} on ${formatCents(routing)} CAD.`
      }
    >
      {plan.outcome === "blocked" && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          <p className="font-semibold">Can&apos;t go to approval yet</p>
          <ul className="mt-1 list-disc pl-5">
            {plan.holdReasons.map((r, i) => (
              <li key={i}>{r.message}</li>
            ))}
          </ul>
        </div>
      )}
      {plan.outcome === "hold" && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-semibold">{preview ? "Submitting would put it on hold" : "On hold"}</p>
          <ul className="mt-1 list-disc pl-5">
            {plan.holdReasons.map((r, i) => (
              <li key={i}>
                {r.message}
                {r.policyId ? <span className="text-amber-700"> ({r.policyId})</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
      {plan.steps.length > 0 && (
        <ol className="space-y-3">
          {plan.steps.map((s) => {
            const d = DECISION[s.decision] ?? DECISION.pending!;
            const isCurrent = !preview && s.decision === "pending" && plan.steps.filter((x) => x.decision === "pending")[0]?.seq === s.seq;
            return (
              <li key={s.seq} className={`rounded-lg border px-4 py-3 ${isCurrent ? "border-violet-300 bg-violet-50/40" : "border-slate-200"}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-900">
                    {s.seq}. {stepRoleLabel(s.role)}
                    {s.alsoCovers.length > 0 && <span className="font-normal text-slate-500"> (also covers {s.alsoCovers.map(stepRoleLabel).join(", ")})</span>}
                  </p>
                  {!preview && <Pill tone={d.tone}>{d.label}</Pill>}
                </div>
                <p className="mt-1 text-sm text-slate-700">
                  {s.decision === "pending" ? (
                    <>
                      {preview ? "Will go to " : "Waiting on "}
                      <span className="font-medium">{isCurrent && current ? current.name : name(s.assignedTo)}</span>
                      {s.onBehalfOf && <span className="text-slate-500"> on behalf of {name(s.onBehalfOf)} (on leave)</span>}
                    </>
                  ) : (
                    <>
                      <span className="font-medium">{s.actedAs?.fullName ?? name(s.actedBy)}</span>
                      {s.onBehalfOf && <span className="text-slate-500"> on behalf of {name(s.onBehalfOf)}</span>} {s.decision} {s.decidedAt ? formatWhen(s.decidedAt) : ""}
                      {s.comment && <span className="block text-slate-500">“{s.comment}”</span>}
                    </>
                  )}
                </p>
                <ul className="mt-1.5 space-y-0.5 text-xs text-slate-500">
                  {s.reasons.map((r, i) => (
                    <li key={i}>
                      {r.policyId && <span className="font-mono text-slate-400">{r.policyId} </span>}
                      {r.message}
                    </li>
                  ))}
                  {s.resolution.map((r, i) => (
                    <li key={`r${i}`} className="text-violet-700">
                      ↳ {r.message}
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ol>
      )}
      {plan.attention.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Approvers must acknowledge</p>
          <ul className="mt-1.5 space-y-1 text-sm">
            {plan.attention.map((a) => (
              <li key={a.code} className="flex items-start gap-2">
                <SeverityBadge severity={a.severity} />
                <span className="text-slate-700">
                  <span className="font-mono text-xs text-slate-500">{a.code}</span> {a.message}
                  {a.status === "overridden" && <span className="text-amber-700"> (overridden)</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {plan.excludedApprovers.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Can&apos;t approve this invoice (separation of duties)</p>
          <ul className="mt-1.5 space-y-0.5 text-sm text-slate-600">
            {plan.excludedApprovers.map((e) => (
              <li key={e.userId}>
                {name(e.userId)} — {e.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {plan.notes.length > 0 && (
        <ul className="mt-4 space-y-0.5 text-xs text-slate-500">
          {plan.notes.map((n, i) => (
            <li key={i}>ℹ︎ {n.message}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** The journal entry the coding would post: debit each line (and its tax), credit Accounts Payable. */
export function JournalTable({ journal, glNames }: { journal: JournalPreview; glNames?: Map<string, string> }) {
  const label = (code: string | null) => (code ? `${code}${glNames?.get(code) ? ` ${glNames.get(code)}` : ""}` : "— not coded");
  const KIND: Record<string, string> = { line: "Line", recoverable_tax: "Recoverable tax", non_recoverable_tax: "Non-recoverable tax (into cost)", unallocated_tax: "Tax not allocated" };
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
            <th className="py-1.5 pr-4 font-semibold">Account</th>
            <th className="py-1.5 pr-4 font-semibold">For</th>
            <th className="py-1.5 pr-4 font-semibold">Dept</th>
            <th className="py-1.5 text-right font-semibold">Debit</th>
            <th className="py-1.5 pl-4 text-right font-semibold">Credit</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {journal.debits.map((d, i) => (
            <tr key={i}>
              <td className="py-1.5 pr-4">{label(d.glAccount)}</td>
              <td className="py-1.5 pr-4 text-slate-500">
                {KIND[d.kind] ?? d.kind}
                {d.lineNo ? ` ${d.lineNo}` : ""}
                {d.taxCode ? ` · ${d.taxCode}` : ""}
              </td>
              <td className="py-1.5 pr-4 text-slate-500">{d.departmentId ?? ""}</td>
              <td className="py-1.5 text-right tabular-nums">{formatCents(d.amountCents)}</td>
              <td />
            </tr>
          ))}
          <tr className="font-medium">
            <td className="py-1.5 pr-4">{label(journal.credit.glAccount)}</td>
            <td className="py-1.5 pr-4 text-slate-500">Accounts payable</td>
            <td />
            <td />
            <td className="py-1.5 pl-4 text-right tabular-nums">{formatCents(journal.credit.amountCents)}</td>
          </tr>
        </tbody>
      </table>
      <p className={`mt-2 text-xs ${journal.balanced ? "text-emerald-700" : "font-semibold text-red-700"}`}>
        {journal.balanced ? "✓ Balanced" : `✗ Does not balance: off by ${formatCents(journal.differenceCents)}`}
        {journal.currency && <span className="text-slate-500"> · amounts in {journal.currency}</span>}
      </p>
    </div>
  );
}

/** The evidence behind a flag, in plain words (contract cap, matching invoice, combined total…). */
export function FlagEvidence({ evidence }: { evidence: Record<string, unknown> }) {
  const entries = Object.entries(evidence).filter(([, v]) => v !== null && v !== undefined && typeof v !== "object");
  if (entries.length === 0) return null;
  return (
    <details className="mt-1 text-xs text-slate-500">
      <summary className="cursor-pointer select-none hover:text-slate-700">Evidence</summary>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {entries.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="font-mono text-slate-400">{k}</dt>
            <dd className="text-slate-600">{/cents$/i.test(k) && typeof v === "number" ? <Money cents={v} /> : String(v)}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
