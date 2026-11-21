import Link from "next/link";
import type { DashboardRole } from "../_lib/access";
import { canAct } from "../_lib/access";
import { canRetry, openFlags, type PaymentRow } from "../_lib/data";
import { formatDate, formatMoney, formatMoneyWithCode } from "../_lib/format";
import type { PaymentRecord } from "@/contracts/payment";
import { actionFor, PaymentAction } from "./ActionsSpot";
import { FlagBadge } from "./Flags";
import { StatusBadge } from "./StatusBadge";

export function PaymentsTable({
  rows,
  role,
  filtered = false,
}: {
  rows: PaymentRow[];
  role: DashboardRole;
  filtered?: boolean;
}) {
  const showActions = canAct(role);

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
        <h2 className="text-sm font-semibold text-slate-900">All payments</h2>
        <p className="text-xs text-slate-500">
          {rows.length} {rows.length === 1 ? "invoice" : "invoices"}
          {filtered ? " match" : ""}
        </p>
      </header>
      {rows.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-slate-500">
          {filtered ? "No payments match these filters." : "No payments yet."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-5 py-2.5">Vendor</th>
                <th className="px-5 py-2.5 text-right">Amount</th>
                <th className="px-5 py-2.5">Due</th>
                <th className="px-5 py-2.5">Scheduled</th>
                <th className="px-5 py-2.5">Status</th>
                <th className="px-5 py-2.5">Released by</th>
                {showActions && <th className="px-5 py-2.5 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <Row key={row.current.paymentId} row={row} role={role} showActions={showActions} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Row({ row, role, showActions }: { row: PaymentRow; role: DashboardRole; showActions: boolean }) {
  const { invoice, current, attempts } = row;
  const isUsd = current.currency !== "CAD";
  const action = current.status === "failed" && !canRetry(row) ? null : actionFor(role, current.status);
  const topFlag = openFlags(row)[0];

  return (
    <tr className="align-top hover:bg-slate-50/60">
      <td className="px-5 py-3.5">
        <Link href={`/payments/${invoice.invoiceId}`} className="font-medium text-slate-900 hover:text-(--brim-link)">
          {invoice.vendorName}
        </Link>
        <p className="text-xs text-slate-500">Invoice {invoice.vendorInvoiceNumber}</p>
      </td>
      <td className="px-5 py-3.5 text-right tabular-nums">
        <p className="font-medium text-slate-900">{formatMoneyWithCode(current.amountCents, current.currency)}</p>
        {isUsd && (
          <p className="text-xs text-slate-500">
            ≈ {formatMoney(current.amountCadCents)} CAD @ {current.fxRateToCad}
          </p>
        )}
      </td>
      <td className="px-5 py-3.5 text-slate-700">{formatDate(invoice.dueDate)}</td>
      <td className="px-5 py-3.5 text-slate-700">{formatDate(current.scheduledDate)}</td>
      <td className="px-5 py-3.5">
        <StatusBadge status={current.status} />
        {current.status === "failed" && current.failure && (
          <p className="mt-1 max-w-56 text-xs text-red-700">{current.failure.message}</p>
        )}
        {topFlag && (
          <div className="mt-1.5">
            <FlagBadge urgency={topFlag.urgency} />
          </div>
        )}
        {current.status === "on_hold" && current.holdReason && (
          <p className="mt-1 max-w-56 text-xs text-amber-800">{current.holdReason}</p>
        )}
        {current.status === "cancelled" && current.cancelReason && (
          <p className="mt-1 max-w-56 text-xs text-slate-500">{current.cancelReason}</p>
        )}
        {attempts.length > 1 && <AttemptHistory attempts={attempts} />}
      </td>
      <td className="px-5 py-3.5 text-slate-700">
        {current.releasedBy?.name ?? <span className="text-slate-400">—</span>}
      </td>
      {showActions && (
        <td className="px-5 py-3.5 text-right">
          {action ? (
            <PaymentAction label={action} invoiceId={invoice.invoiceId} paymentId={current.paymentId} align="end" />
          ) : (
            <span className="text-slate-300">—</span>
          )}
        </td>
      )}
    </tr>
  );
}

function AttemptHistory({ attempts }: { attempts: PaymentRecord[] }) {
  return (
    <details className="group mt-1.5">
      <summary className="cursor-pointer list-none text-xs font-medium text-(--brim-link) hover:underline">
        {attempts.length} attempts <span className="inline-block transition group-open:rotate-90">›</span>
      </summary>
      <ol className="mt-2 space-y-1.5 border-l-2 border-slate-200 pl-3">
        {attempts.map((a) => (
          <li key={a.paymentId} className="text-xs text-slate-600">
            <span className="font-medium text-slate-800">Attempt {a.attemptNo}:</span> {describeAttempt(a)}
          </li>
        ))}
      </ol>
    </details>
  );
}

export function describeAttempt(a: PaymentRecord): string {
  switch (a.status) {
    case "failed":
      return `Failed ${formatDate(a.failedAt)}${a.failure ? `, ${a.failure.message.toLowerCase()}` : ""}`;
    case "settled":
      return `Settled ${formatDate(a.settledAt)}`;
    case "released":
      return `Released ${formatDate(a.releasedAt)} by ${a.releasedBy?.name ?? "—"}`;
    case "scheduled":
      return `Scheduled for ${formatDate(a.scheduledDate)}`;
    case "on_hold":
      return "On hold";
    case "cancelled":
      return "Cancelled";
  }
}
