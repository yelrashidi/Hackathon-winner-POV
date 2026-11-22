import type { Metadata } from "next";
import Link from "next/link";
import { listVendors } from "@/server/dashboard/records";
import { getViewer } from "@/server/session/current-user";
import { ActionForm } from "../_components/ActionForm";
import { fieldClass } from "../_lib/styles";
import { NotForYourRole } from "../_components/NotForYourRole";
import { Card, Money, PageHeader, Pill, Table, td } from "../_components/ui";
import { first } from "../_lib/format";
import { canSee } from "../_lib/nav";
import { createVendorAction } from "./actions";
import { vendorTone } from "./tone";

export const metadata: Metadata = { title: "Vendors" };

export default async function VendorsPage({ searchParams }: PageProps<"/vendors">) {
  const viewer = await getViewer();
  if (!canSee(viewer?.role ?? null, "vendors")) return <NotForYourRole sectionKey="vendors" viewer={viewer} />;
  const [rows, params] = await Promise.all([listVendors(viewer!.actor), searchParams]);
  const q = first(params.q).toLowerCase();
  const show = first(params.show);
  const shown = rows.filter(
    (v) =>
      (!q || v.legalName.toLowerCase().includes(q) || v.category.toLowerCase().includes(q) || v.vendorId.toLowerCase() === q) &&
      (!show || (show === "attention" ? v.status !== "active" || v.pendingBankChange || v.openPaymentFlags > 0 : true)),
  );
  const attention = rows.filter((v) => v.status !== "active" || v.pendingBankChange || v.openPaymentFlags > 0).length;

  return (
    <>
      <PageHeader title="Vendors" description="The vendor master: status, bank details by version, and what is open with each supplier. A bank change is a controlled action: one person enters it, a different person verifies it." />
      <div className="flex flex-wrap items-center gap-3">
        <form action="/vendors" className="flex gap-2">
          <input name="q" defaultValue={q} placeholder="Search vendors" className={`w-64 ${fieldClass}`} />
          <button className="rounded-lg bg-white px-3 py-1.5 text-sm font-medium ring-1 ring-inset ring-slate-300 hover:bg-slate-50">Search</button>
        </form>
        <Link href={show === "attention" ? "/vendors" : "/vendors?show=attention"} className={`rounded-full px-3 py-1 text-sm font-medium ring-1 ring-inset ${show === "attention" ? "bg-(--brim-frame) text-white ring-(--brim-frame)" : "bg-white text-slate-700 ring-slate-200"}`}>
          Needs attention <span className="tabular-nums opacity-70">{attention}</span>
        </Link>
      </div>
      <Table head={["Vendor", "Category", "Status", "Bank account", "Open bills", "Paid (CAD)"]}>
        {shown.map((v) => (
          <tr key={v.vendorId} className="hover:bg-slate-50/70">
            <td className={td}>
              <Link href={`/vendors/${v.vendorId}`} className="font-medium text-slate-900 hover:text-(--brim-link) hover:underline">
                {v.legalName}
              </Link>
              <p className="text-xs text-slate-500">
                {v.vendorId} · {v.province ?? "—"}
                {v.requiresPo ? " · PO required" : ""}
              </p>
            </td>
            <td className={`${td} text-sm text-slate-600`}>{v.category}</td>
            <td className={td}>
              <Pill tone={vendorTone(v.status)}>{v.status.replace("_", " ")}</Pill>
            </td>
            <td className={`${td} text-sm`}>
              {v.bank ? `••••${v.bank.last4} (v${v.bank.version})` : <span className="text-red-700">none verified</span>}
              {v.pendingBankChange && (
                <p>
                  <Pill tone="amber">change to verify</Pill>
                </p>
              )}
              {v.openPaymentFlags > 0 && (
                <p>
                  <Pill tone="red">{v.openPaymentFlags} payment flag(s)</Pill>
                </p>
              )}
            </td>
            <td className={`${td} tabular-nums`}>{v.openInvoices}</td>
            <td className={`${td} whitespace-nowrap`}>
              <Money cents={v.paidCadCents} />
            </td>
          </tr>
        ))}
      </Table>

      <Card title="Onboard a new vendor" description="It starts as pending review: its bills can be checked and get an extra Finance Manager approval step (P05), and someone other than you approves the vendor.">
        <ActionForm action={createVendorAction} label="Add vendor" layout="stacked" size="md">
          <div className="grid gap-3 sm:grid-cols-3">
            <input name="legalName" required placeholder="Legal name *" className={fieldClass} />
            <input name="category" required placeholder="Category * (e.g. Freight, Software, Legal)" className={fieldClass} />
            <input name="province" placeholder="Province (ON, QC…)" className={fieldClass} />
            <input name="gst" placeholder="GST/HST number" className={fieldClass} />
            <input name="email" type="email" placeholder="AP contact email" className={fieldClass} />
            <input name="terms" type="number" min={0} placeholder="Payment terms (days)" className={fieldClass} />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" name="requiresPo" value="1" className="accent-(--brim-link)" /> Bills from this vendor require a PO
          </label>
        </ActionForm>
      </Card>
    </>
  );
}
