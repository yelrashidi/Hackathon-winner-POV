import Link from "next/link";
import type { DashboardRole } from "../_lib/access";
import { canAct } from "../_lib/access";
import { formatDate, formatMoneyWithCode } from "../_lib/format";
import type { InvoiceRecord } from "../_lib/types";
import { actionFor, ActionsSpot } from "./ActionsSpot";
import { StatusBadge } from "./StatusBadge";

/** Approved invoices with no payment yet, ready to schedule. */
export function AwaitingPayment({ invoices, role }: { invoices: InvoiceRecord[]; role: DashboardRole }) {
  const action = canAct(role) ? actionFor(role, "awaiting") : null;

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
        <h2 className="text-sm font-semibold text-slate-900">Approved, not scheduled</h2>
        <p className="text-xs text-slate-500">
          {invoices.length} {invoices.length === 1 ? "invoice" : "invoices"}
        </p>
      </header>
      {invoices.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-slate-500">Every approved invoice has a payment scheduled.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {invoices.map((inv) => (
            <li key={inv.invoiceId} className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3.5 text-sm">
              <div className="min-w-56 flex-1">
                <Link href={`/payments/${inv.invoiceId}`} className="font-medium text-slate-900 hover:text-indigo-600">
                  {inv.vendorName}
                </Link>
                <p className="text-xs text-slate-500">
                  Invoice {inv.vendorInvoiceNumber} · approved by {inv.approvedBy.map((p) => p.name).join(", ")}
                </p>
              </div>
              <p className="text-slate-600">Due {formatDate(inv.dueDate)}</p>
              <StatusBadge status="awaiting" />
              <p className="w-32 text-right font-medium tabular-nums text-slate-900">
                {formatMoneyWithCode(inv.totalCents, inv.currency)}
              </p>
              {action && <ActionsSpot label={action} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
