import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { can } from "@/server/core/authorize";
import { getVendor } from "@/server/dashboard/records";
import { getViewer } from "@/server/session/current-user";
import { ActionForm } from "../../_components/ActionForm";
import { inputClass } from "../../_lib/styles";
import { NotForYourRole } from "../../_components/NotForYourRole";
import { Card, Day, InvoiceStatus, KeyValues, Money, Notice, PageHeader, Pill, TextLink } from "../../_components/ui";
import { formatWhen } from "../../_lib/format";
import { canSee } from "../../_lib/nav";
import { rejectBankChangeAction, requestBankChangeAction, vendorStatusAction, verifyBankChangeAction } from "../actions";
import { vendorTone } from "../tone";

export const metadata: Metadata = { title: "Vendor" };

export default async function VendorPage({ params }: PageProps<"/vendors/[vendorId]">) {
  const viewer = await getViewer();
  if (!canSee(viewer?.role ?? null, "vendors")) return <NotForYourRole sectionKey="vendors" viewer={viewer} />;
  const { vendorId } = await params;
  const d = await getVendor(viewer!.actor, decodeURIComponent(vendorId));
  if (!d) notFound();
  const v = d.vendor;
  const pending = d.bank.find((b) => b.status === "pending");
  const canVerify = can(viewer!.actor, "vendor.bank_change.verify");
  const canRequest = can(viewer!.actor, "vendor.bank_change.request");

  return (
    <>
      <PageHeader
        eyebrow={
          <>
            <TextLink href="/vendors">Vendors</TextLink> · {v.id}
          </>
        }
        title={v.legalName}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Pill tone={vendorTone(v.status)}>{v.status.replace("_", " ")}</Pill>
            <span>{v.category}</span>
            {v.requiresPo && <Pill>PO required</Pill>}
          </span>
        }
      />
      {v.status === "pending_review" && <Notice tone="warn" title="Pending review">Bills from this vendor get an extra Finance Manager approval step (P05) until it is approved.</Notice>}
      {v.status === "on_hold" && <Notice tone="danger" title="On hold">Bills from this vendor are flagged and won&apos;t be paid until the hold is released.</Notice>}

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <Card title="Details">
            <KeyValues
              items={[
                { label: "Address", value: v.address ?? "—" },
                { label: "Province / country", value: `${v.provinceOrState ?? "—"} · ${v.country ?? "—"}` },
                { label: "GST/HST", value: v.gstHstNumber ?? "—" },
                { label: "QST", value: v.qstNumber ?? "—" },
                { label: "Terms", value: v.paymentTermsDays ? `${v.paymentTermsDays} days${v.earlyPayDiscount ? ` · ${v.earlyPayDiscount}` : ""}` : "—" },
                { label: "Pays by", value: `${v.preferredPaymentMethod ?? "EFT"}${v.acceptsCardPayment ? " · accepts card" : ""}` },
                { label: "AP contact", value: v.apContactEmail ?? "—" },
                { label: "Onboarded", value: <Day value={v.onboardedAt} /> },
                { label: "Default GL", value: v.defaultGlAccount ?? "—" },
              ]}
            />
            {canVerify && (
              <div className="mt-4 border-t border-slate-100 pt-3">
                <ActionForm action={vendorStatusAction} label="Change status" hidden={{ vendorId: v.id }} tone="quiet">
                  <select name="status" defaultValue={v.status === "on_hold" ? "release" : v.status === "pending_review" ? "approve" : "on_hold"} aria-label="New status" className={inputClass}>
                    {v.status === "pending_review" && <option value="approve">Approve (second person)</option>}
                    {v.status === "on_hold" ? <option value="release">Lift the hold</option> : <option value="on_hold">Put on hold</option>}
                  </select>
                  <input name="note" required placeholder="Why (required)" aria-label="Note" className={`w-56 ${inputClass}`} />
                </ActionForm>
              </div>
            )}
          </Card>

          <Card title="Bank account" description="Every version is kept; a payment always points at the exact version it paid to.">
            <ul className="space-y-2">
              {d.bank.map((b) => (
                <li key={b.version} className={`rounded-lg border px-3 py-2 text-sm ${b.status === "verified" ? "border-emerald-200" : b.status === "pending" ? "border-amber-200 bg-amber-50/40" : "border-slate-200 opacity-75"}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">••••{b.last4}</span>
                    <span className="text-xs text-slate-500">version {b.version} · {b.currency}</span>
                    <Pill tone={b.status === "verified" ? "emerald" : b.status === "pending" ? "amber" : b.status === "closed" ? "red" : "slate"}>{b.status}</Pill>
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {b.changedAt ? `Changed ${b.changedAt}` : "Original account"}
                    {b.channel ? ` via ${b.channel.replace(/_/g, " ")}` : ""}
                    {b.requestedBy ? ` · entered by ${b.requestedBy.name}` : ""}
                    {b.verifiedBy ? ` · verified by ${b.verifiedBy.name}${b.verifiedAt ? ` ${formatWhen(b.verifiedAt)}` : ""}` : ""}
                  </p>
                </li>
              ))}
            </ul>
            {pending && canVerify && (
              <div className="mt-4 space-y-2 border-t border-slate-100 pt-3">
                <p className="text-sm text-slate-700">
                  New details ••••{pending.last4} were entered by {pending.requestedBy?.name ?? "someone"}. Call the supplier on the number on file before verifying.
                </p>
                <div className="flex flex-wrap gap-3">
                  <ActionForm action={verifyBankChangeAction} label="Verify (second person)" hidden={{ vendorId: v.id }} tone="success" />
                  <ActionForm action={rejectBankChangeAction} label="Reject" hidden={{ vendorId: v.id }} tone="quiet">
                    <input name="reason" placeholder="Why" aria-label="Reason" className={`w-40 ${inputClass}`} />
                  </ActionForm>
                </div>
              </div>
            )}
            {!pending && canRequest && (
              <details className="mt-4 border-t border-slate-100 pt-3">
                <summary className="cursor-pointer text-sm font-medium text-(--brim-link)">Enter new bank details</summary>
                <div className="mt-2">
                  <ActionForm action={requestBankChangeAction} label="Save for verification" hidden={{ vendorId: v.id }}>
                    <input name="institution" required placeholder="Institution (3 digits)" aria-label="Institution" className={`w-36 ${inputClass}`} />
                    <input name="transit" required placeholder="Transit (5 digits)" aria-label="Transit" className={`w-32 ${inputClass}`} />
                    <input name="account" required placeholder="Account number" aria-label="Account" className={`w-40 ${inputClass}`} />
                  </ActionForm>
                  <p className="mt-1 text-xs text-slate-500">Nothing is paid to new details until a different person verifies them.</p>
                </div>
              </details>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="Bills" description="Most recent 40." padded={false}>
            <ul className="divide-y divide-slate-100">
              {d.invoices.map((i) => (
                <li key={i.invoiceId}>
                  <Link href={["ManualEntry", "InReview", "OnHold"].includes(i.status) && canSee(viewer!.role, "checks") ? `/checks/${i.invoiceId}` : `/audit/${i.invoiceId}`} className="flex items-center gap-3 px-5 py-2.5 text-sm hover:bg-slate-50">
                    <span className="min-w-0 flex-1">
                      <span className="block font-mono text-xs text-slate-700">{i.invoiceNumber ?? i.invoiceId}</span>
                      <span className="block text-xs text-slate-500">
                        <Day value={i.invoiceDate} />
                      </span>
                    </span>
                    <InvoiceStatus status={i.status} />
                    <Money cents={i.totalCents} currency={i.currency} />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
          {d.contracts.length > 0 && (
            <Card title="Contracts">
              <ul className="space-y-2 text-sm">
                {d.contracts.map((c) => (
                  <li key={c.id}>
                    <span className="font-medium text-slate-900">{c.id}</span> {c.description}
                    <span className="block text-xs text-slate-500">
                      {c.billingType.replace(/_/g, " ")} · {c.startDate} → {c.endDate} · {c.status}
                      {c.hourlyRateCapCents ? ` · rate cap ${(c.hourlyRateCapCents / 100).toFixed(2)}` : ""}
                      {c.monthlyFeeCents ? ` · ${(c.monthlyFeeCents / 100).toFixed(2)}/month` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {d.history.length > 0 && (
            <Card title="Bank-detail history">
              <ul className="space-y-1 text-xs text-slate-600">
                {d.history.map((h, i) => (
                  <li key={i}>
                    {formatWhen(h.at)} · <span className="font-mono">{h.action}</span> by {h.actor?.name ?? "—"}
                    {h.reason ? ` · “${h.reason}”` : ""}
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
