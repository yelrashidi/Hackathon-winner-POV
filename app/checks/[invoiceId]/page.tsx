import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCheck, reviewOptions, type CheckDetail } from "@/server/dashboard/checks";
import { getViewer } from "@/server/session/current-user";
import { ActionForm } from "../../_components/ActionForm";
import { fieldClass, inputClass } from "../../_lib/styles";
import { ApprovalRoute, DocumentViewer, FlagEvidence, JournalTable } from "../../_components/invoice";
import { NotForYourRole } from "../../_components/NotForYourRole";
import { Card, ConfidenceBadge, Day, InvoiceStatus, KeyValues, Money, Notice, PageHeader, Pill, SeverityBadge, TextLink } from "../../_components/ui";
import { centsToInput, formatWhen } from "../../_lib/format";
import { canSee } from "../../_lib/nav";
import { InvoiceProgress } from "../../_components/InvoiceProgress";
import { acceptConfidentAction, codeLineAction, editFieldsAction, flagAction, releaseHoldAction, submitAction } from "../actions";
import { ManualEntryForm } from "./ManualEntryForm";

export const metadata: Metadata = { title: "Check invoice" };

const PROVINCES = ["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"];

/** Which extraction confidence keys belong to which form field. */
const CONFIDENCE_KEYS: Record<string, string[]> = {
  invoiceNumber: ["invoiceNumber"],
  invoiceDate: ["invoiceDate"],
  dueDate: ["dueDate"],
  currency: ["currency"],
  poId: ["poNumber"],
  shipToProvince: ["shipToProvince"],
  subtotalCents: ["subtotalCents", "subtotal"],
  totalCents: ["totalCents", "total"],
};

export default async function CheckPage({ params }: PageProps<"/checks/[invoiceId]">) {
  const viewer = await getViewer();
  if (!canSee(viewer?.role ?? null, "checks")) return <NotForYourRole sectionKey="checks" viewer={viewer} />;
  const { invoiceId } = await params;
  const [check, options] = await Promise.all([getCheck(viewer!.actor, decodeURIComponent(invoiceId)), reviewOptions(viewer!.actor)]);
  if (!check) notFound();
  const { invoice: inv } = check;
  const editable = inv.status === "InReview";
  const low = new Set(check.lowConfidence);
  const unsure = (field: string) => (CONFIDENCE_KEYS[field] ?? [field]).some((k) => low.has(k));

  return (
    <>
      <PageHeader
        eyebrow={
          <>
            <TextLink href="/checks">Checks</TextLink> · <span className="font-mono">{inv.invoiceId}</span>
          </>
        }
        title={check.vendor?.legalName ?? inv.vendorNameRaw ?? "Unread document"}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <InvoiceStatus status={inv.status} />
            {inv.invoiceNumber && <span className="font-mono text-xs">#{inv.invoiceNumber}</span>}
            {inv.totalCents !== null && <Money cents={inv.totalCents} currency={inv.currency} cadCents={inv.totalCadCents} className="font-medium text-slate-900" />}
            {inv.dueDate && (
              <span>
                · due <Day value={inv.dueDate} />
              </span>
            )}
            {inv.isCreditNote && <Pill tone="sky">Credit note</Pill>}
          </span>
        }
      >
        {canSee(viewer!.role, "audit") ? <TextLink href={`/audit/${inv.invoiceId}`}>Audit trail →</TextLink> : <TextLink href={`/invoices/${inv.invoiceId}`}>Invoice record →</TextLink>}
      </PageHeader>

      <InvoiceProgress actor={viewer!.actor} invoiceId={inv.invoiceId} />

      <Banners check={check} />

      {inv.status === "ManualEntry" ? (
        <div className="grid gap-6 xl:grid-cols-2">
          <div className="xl:sticky xl:top-20 xl:self-start">
            <DocumentViewer document={check.document} />
          </div>
          <ManualEntryForm invoiceId={inv.invoiceId} people={options.people} departments={options.departments} taxCodes={options.taxCodes} />
        </div>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="xl:sticky xl:top-20 xl:self-start">
            <DocumentViewer document={check.document} />
          </div>

          <div className="min-w-0 space-y-6">
            <Card title="Invoice details" description={editable ? "Compare with the document and correct anything that was read wrong. Saving runs validation and coding again." : "Read-only: the invoice is not in review."}>
              {editable ? (
                <ActionForm action={editFieldsAction} label="Save changes" pendingLabel="Saving…" hidden={{ invoiceId: inv.invoiceId }} layout="stacked" size="md">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Requester (who asked for it)" required hint={!inv.requesterId ? "Approvals routes on this — set it." : undefined}>
                      <Select name="requesterId" value={inv.requesterId} options={options.people} />
                    </Field>
                    <Field label="Department">
                      <Select name="departmentId" value={inv.departmentId} options={options.departments} />
                    </Field>
                    <Field label="Invoice number" unsure={unsure("invoiceNumber")}>
                      <Input name="invoiceNumber" value={inv.invoiceNumber} />
                    </Field>
                    <Field label="PO" unsure={unsure("poId")} hint={inv.poNumberRead && !inv.poId ? `Read “${inv.poNumberRead}” — no such open PO.` : undefined}>
                      <Select name="poId" value={inv.poId} options={options.purchaseOrders.filter((p) => !inv.vendorId || p.vendorId === inv.vendorId)} empty="No PO" />
                    </Field>
                    <Field label="Invoice date" unsure={unsure("invoiceDate")}>
                      <Input name="invoiceDate" value={inv.invoiceDate} type="date" />
                    </Field>
                    <Field label="Due date" unsure={unsure("dueDate")}>
                      <Input name="dueDate" value={inv.dueDate} type="date" />
                    </Field>
                    <Field label="Currency" unsure={unsure("currency")}>
                      <Select name="currency" value={inv.currency} options={[{ value: "CAD", label: "CAD" }, { value: "USD", label: "USD" }]} />
                    </Field>
                    <Field label="Ship-to province" unsure={unsure("shipToProvince")}>
                      <Select name="shipToProvince" value={inv.shipToProvince} options={PROVINCES.map((p) => ({ value: p, label: p }))} empty="—" />
                    </Field>
                    <Field label="Subtotal" unsure={unsure("subtotalCents")}>
                      <Input name="subtotalCents" value={centsToInput(inv.subtotalCents)} />
                    </Field>
                    <Field label="Total" unsure={unsure("totalCents")} hint={inv.currency === "USD" && inv.totalCadCents !== null ? `= ${centsToInput(inv.totalCadCents)} CAD at ${inv.fxRate}` : undefined}>
                      <Input name="totalCents" value={centsToInput(inv.totalCents)} />
                    </Field>
                  </div>
                  <input name="reason" placeholder="What did you correct? (optional, kept in the audit trail)" className={fieldClass} />
                </ActionForm>
              ) : (
                <KeyValues
                  items={[
                    { label: "Requester", value: check.names[inv.requesterId ?? ""]?.name ?? options.people.find((p) => p.value === inv.requesterId)?.label ?? "—" },
                    { label: "Department", value: options.departments.find((d) => d.value === inv.departmentId)?.label ?? "—" },
                    { label: "Invoice date", value: <Day value={inv.invoiceDate} /> },
                    { label: "PO", value: inv.poId ?? "—" },
                  ]}
                />
              )}
              <div className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">
                Vendor master:{" "}
                {check.vendor ? (
                  <>
                    <TextLink href={`/vendors/${check.vendor.vendorId}`}>{check.vendor.legalName}</TextLink> · {check.vendor.category} · <VendorStatus status={check.vendor.status} />
                    {check.vendor.requiresPo && " · requires a PO"}
                  </>
                ) : (
                  <span className="font-medium text-red-700">not matched — “{inv.vendorNameRaw ?? "?"}” is not a known vendor</span>
                )}
              </div>
            </Card>

            <CodingCard check={check} options={options} editable={editable} />
            <FlagsCard check={check} editable={editable} />

            {editable && (
              <>
                {check.preview ? (
                  <ApprovalRoute plan={check.preview} names={check.names} preview title="If you submit now" />
                ) : (
                  <Notice tone="warn" title="Approvals can't preview this yet">
                    Set the requester and department, and make sure the total (and an FX rate for USD) is there.
                  </Notice>
                )}
                <Card title="Send to approval">
                  <p className="mb-3 text-sm text-slate-600">
                    Approvals routes it by the policy rules and sends it to the first approver. You can&apos;t approve it yourself: whoever submits an invoice is excluded from its approval.
                  </p>
                  <ActionForm action={submitAction} label="Submit for approval" pendingLabel="Routing…" hidden={{ invoiceId: inv.invoiceId }} size="md" />
                </Card>
              </>
            )}
            {!editable && check.latestPlan && <ApprovalRoute plan={check.latestPlan} names={check.names} />}
          </div>
        </div>
      )}
    </>
  );
}

function Banners({ check }: { check: CheckDetail }) {
  const inv = check.invoice;
  return (
    <div className="space-y-3">
      {inv.status === "ManualEntry" && (
        <Notice tone="warn" title="Extraction couldn't read this document">
          Type the details from the original on the left. Saving sends it through validation and coding like any other bill.
        </Notice>
      )}
      {inv.status === "PendingApproval" && (
        <Notice tone="success" title="Sent to approval">
          {(() => {
            const step = check.latestPlan?.steps.find((s) => s.decision === "pending");
            const who = step ? (check.names[step.assignedTo]?.name ?? step.assignedTo) : null;
            return who ? `Waiting on ${who} (step ${step!.seq} of ${check.latestPlan!.steps.length}). ` : "";
          })()}
          <TextLink href={`/approvals/${inv.invoiceId}`}>Open it in Approvals →</TextLink>
        </Notice>
      )}
      {["Approved", "PaymentScheduled", "Paid"].includes(inv.status) && (
        <Notice tone="success" title={inv.status === "Paid" ? "Paid" : inv.status === "Approved" ? "Approved — ready for payment" : "Payment scheduled"}>
          <TextLink href={`/payments/${inv.invoiceId}`}>See the payment →</TextLink>
        </Notice>
      )}
      {check.rejection && (
        <Notice tone="danger" title={`Rejected by ${check.rejection.by?.name ?? "an approver"} ${check.rejection.at ? `· ${formatWhen(check.rejection.at)}` : ""}`}>
          {check.rejection.comment ? `“${check.rejection.comment}”` : "No comment."} Fix what they asked, then submit again — it is routed from scratch.
        </Notice>
      )}
      {inv.status === "OnHold" && (
        <Notice tone="warn" title="On hold">
          <ul className="list-disc pl-5">
            {(check.latestPlan?.holdReasons ?? []).map((r, i) => (
              <li key={i}>{r.message}</li>
            ))}
          </ul>
          <div className="mt-3">
            <ActionForm action={releaseHoldAction} label="Back to review" hidden={{ invoiceId: inv.invoiceId }}>
              <input name="note" required placeholder="What was done about it? (required)" className={`w-80 ${inputClass}`} />
            </ActionForm>
          </div>
        </Notice>
      )}
      {check.lowConfidence.length > 0 && inv.status === "InReview" && (
        <Notice tone="warn" title="Check these against the document">
          Extraction was less than 80% sure of: {check.lowConfidence.join(", ")}. They are marked below.
        </Notice>
      )}
      {(check.provenance.intakeReason || check.provenance.warnings.length > 0) && (
        <p className="text-xs text-slate-500">
          {inv.source === "upload" ? "Uploaded" : "Arrived by email"}
          {check.provenance.inboxMessageId ? ` (${check.provenance.inboxMessageId})` : ""}
          {check.provenance.intakeReason ? ` · intake: ${check.provenance.intakeReason}` : ""}
          {check.provenance.warnings.length ? ` · extraction warnings: ${check.provenance.warnings.join("; ")}` : ""}
        </p>
      )}
    </div>
  );
}

function CodingCard({ check, options, editable }: { check: CheckDetail; options: Awaited<ReturnType<typeof reviewOptions>>; editable: boolean }) {
  const pending = check.lines.filter((l) => l.source === "suggested");
  const confident = pending.filter((l) => l.account.confidence === "high").length;
  const glNames = new Map(options.accounts.map((a) => [a.value, a.label.slice(a.value.length + 1)]));
  return (
    <Card
      title="Coding"
      description="A GL account and department for every line, learned from past invoices. Accept or change each; every line must be confirmed by a person."
      action={
        editable && confident > 0 ? (
          <ActionForm action={acceptConfidentAction} label={`Accept ${confident} high-confidence`} hidden={{ invoiceId: check.invoice.invoiceId, minimum: "high" }} tone="success" align="end" />
        ) : undefined
      }
    >
      {check.lines.length === 0 ? (
        <p className="text-sm text-slate-500">No lines.</p>
      ) : (
        <ul className="space-y-4">
          {check.lines.map((l) => (
            <li key={l.lineNo} className={`rounded-lg border px-4 py-3 ${l.source === "suggested" ? (l.account.confidence === "high" ? "border-slate-200" : "border-violet-200 bg-violet-50/30") : "border-emerald-200 bg-emerald-50/30"}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <p className="min-w-0 flex-1 text-sm font-medium text-slate-900">
                  {l.lineNo}. {l.description}
                  <span className="ml-2 text-xs font-normal text-slate-500">
                    {l.quantity} × <Money cents={l.unitPriceCents} />
                    {l.lineType ? ` · ${l.lineType}` : ""}
                  </span>
                </p>
                <Money cents={l.amountCents} className="text-sm font-semibold" />
              </div>
              <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                <div>
                  <p className="flex items-center gap-1.5 text-slate-500">
                    Account <ConfidenceBadge confidence={l.account.confidence} />
                  </p>
                  <p className="mt-0.5 text-slate-700">{l.account.reason}</p>
                  {l.account.alternatives.length > 0 && <p className="mt-0.5 text-slate-400">Also seen: {l.account.alternatives.map((a) => `${a.label} (${a.count})`).join(", ")}</p>}
                </div>
                <div>
                  <p className="flex items-center gap-1.5 text-slate-500">
                    Department <ConfidenceBadge confidence={l.department.confidence} />
                  </p>
                  <p className="mt-0.5 text-slate-700">{l.department.reason}</p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2">
                {l.source !== "suggested" && (
                  <Pill tone="emerald">
                    {l.source === "changed" ? "Changed" : "Accepted"} by {l.codedByName ?? l.codedBy}
                  </Pill>
                )}
                {editable ? (
                  <ActionForm action={codeLineAction} label={l.source === "suggested" ? "Confirm" : "Update"} hidden={{ invoiceId: check.invoice.invoiceId, lineNo: String(l.lineNo) }}>
                    <select name="glAccount" defaultValue={l.glAccount ?? ""} aria-label="GL account" className={`max-w-64 ${inputClass}`}>
                      <option value="">Choose account…</option>
                      {options.accounts.map((a) => (
                        <option key={a.value} value={a.value}>
                          {a.label}
                        </option>
                      ))}
                    </select>
                    <select name="departmentId" defaultValue={l.departmentId ?? ""} aria-label="Department" className={`max-w-44 ${inputClass}`}>
                      <option value="">Department…</option>
                      {options.departments.map((d) => (
                        <option key={d.value} value={d.value}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                    <input name="note" placeholder={l.account.confidence === "high" ? "Note (needed if you change it)" : "Note (optional)"} defaultValue={l.note ?? ""} aria-label="Note" className={`w-52 ${inputClass}`} />
                  </ActionForm>
                ) : (
                  <span className="text-xs text-slate-600">
                    Posts to {l.glAccount ?? "—"} {l.glName ?? ""} · {l.departmentName ?? l.departmentId ?? "—"}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {check.journal && (
        <div className="mt-5 border-t border-slate-100 pt-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Journal entry it will post</p>
          <JournalTable journal={check.journal} glNames={glNames} />
        </div>
      )}
    </Card>
  );
}

function FlagsCard({ check, editable }: { check: CheckDetail; editable: boolean }) {
  const open = check.flags.filter((f) => f.status === "open");
  const closed = check.flags.filter((f) => f.status !== "open");
  const order = { block: 0, warn: 1, info: 2 } as const;
  return (
    <Card title="Flags" description={open.length ? `${open.length} open. Blocking flags must be resolved (cause fixed) or overridden (accepted, with a reason) before submitting.` : "No open flags."}>
      {check.flags.length === 0 ? (
        <p className="text-sm text-slate-500">Validation and coding found nothing to flag.</p>
      ) : (
        <ul className="space-y-3">
          {[...open.sort((a, b) => order[a.severity] - order[b.severity]), ...closed].map((f) => (
            <li key={f.id} className={`rounded-lg border px-4 py-3 ${f.status === "open" ? (f.severity === "block" ? "border-red-200" : "border-slate-200") : "border-slate-100 opacity-70"}`}>
              <div className="flex flex-wrap items-center gap-2">
                <SeverityBadge severity={f.severity} />
                <span className="font-mono text-xs text-slate-500">{f.code}</span>
                <span className="text-xs text-slate-400">· {f.source}</span>
                {f.status !== "open" && <Pill tone={f.status === "overridden" ? "amber" : "emerald"}>{f.status}</Pill>}
              </div>
              <p className="mt-1 text-sm text-slate-800">{f.message}</p>
              {f.relatedInvoiceId && (
                <p className="mt-0.5 text-xs text-slate-500">
                  Related invoice:{" "}
                  <TextLink href={canSee(viewer!.role, "audit") ? `/audit/${f.relatedInvoiceId}` : `/invoices/${f.relatedInvoiceId}`}>{f.relatedInvoiceId}</TextLink>
                </p>
              )}
              <FlagEvidence evidence={f.evidence} />
              {f.status !== "open" && (
                <p className="mt-1 text-xs text-slate-500">
                  {f.status === "overridden" ? "Overridden" : "Resolved"} by {f.resolvedBy?.name ?? "system"}
                  {f.resolvedAt ? `, ${formatWhen(f.resolvedAt)}` : ""}
                  {f.note ? `: “${f.note}”` : ""}
                </p>
              )}
              {editable && f.status === "open" && f.source !== "coding" && (
                <div className="mt-2">
                  <ActionForm action={flagAction} label="Save decision" hidden={{ flagId: String(f.id) }} tone="quiet">
                    <select name="decision" defaultValue="resolve" aria-label="Decision" className={inputClass}>
                      <option value="resolve">Resolved — cause fixed</option>
                      <option value="override">Override — accept as is</option>
                    </select>
                    <input name="note" required placeholder="Why (required)" aria-label="Note" className={`w-64 ${inputClass}`} />
                  </ActionForm>
                </div>
              )}
              {editable && f.status === "open" && f.source === "coding" && <p className="mt-1 text-xs text-violet-700">Clears itself when the lines are confirmed above.</p>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function VendorStatus({ status }: { status: string }) {
  return <Pill tone={status === "active" ? "emerald" : status === "on_hold" ? "red" : "amber"}>{status.replace("_", " ")}</Pill>;
}

function Field({ label, children, required, unsure, hint }: { label: string; children: React.ReactNode; required?: boolean; unsure?: boolean; hint?: string }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 flex items-center gap-2 text-xs font-medium text-slate-600">
        {label}
        {required && <span className="text-red-600">*</span>}
        {unsure && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-900">Check this</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-amber-700">{hint}</span>}
    </label>
  );
}

function Input({ name, value, type = "text" }: { name: string; value: string | null; type?: string }) {
  return (
    <>
      <input type="hidden" name={`was_${name}`} value={value ?? ""} />
      <input name={name} type={type} defaultValue={value ?? ""} className={fieldClass} />
    </>
  );
}

function Select({ name, value, options, empty = "Choose…" }: { name: string; value: string | null; options: { value: string; label: string }[]; empty?: string }) {
  return (
    <>
      <input type="hidden" name={`was_${name}`} value={value ?? ""} />
      <select name={name} defaultValue={value ?? ""} className={fieldClass}>
        <option value="">{empty}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </>
  );
}
