import Link from "next/link";
import type { DirectoryUser } from "@/server/session/users";
import type { PaymentRow } from "../_lib/data";
import { formatDate, formatMoney, formatMoneyWithCode } from "../_lib/format";
import type { Blocker, BlockerCode } from "../_lib/release-check";
import { ActionsSpot } from "./ActionsSpot";

export type ReleaseItem = { row: PaymentRow; blockers: Blocker[]; releasers: DirectoryUser[] };

const CHIP: Record<Exclude<BlockerCode, "NOT_A_RELEASER">, { label: string; className: string }> = {
  NEEDS_CONTROLLER: { label: "Needs Controller", className: "bg-amber-50 text-amber-800 ring-amber-200" },
  APPROVED_IT: { label: "You approved it", className: "bg-rose-50 text-rose-700 ring-rose-200" },
  REQUESTED_IT: { label: "You requested it", className: "bg-rose-50 text-rose-700 ring-rose-200" },
  SCHEDULED_IT: { label: "You scheduled it", className: "bg-rose-50 text-rose-700 ring-rose-200" },
  FRAUD_HOLD: { label: "Fraud hold", className: "bg-red-600 text-white ring-red-600" },
  BANK_NOT_PAYABLE: { label: "Bank account failed", className: "bg-amber-100 text-amber-900 ring-amber-300" },
};

export function ReleaseQueueTable({
  items,
  showYourCheck,
  showActions,
}: {
  items: ReleaseItem[];
  /** The signed-in person can release, so show "Can you release?" for them. */
  showYourCheck: boolean;
  showActions: boolean;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
        <h2 className="text-sm font-semibold text-slate-900">Scheduled payments</h2>
        <p className="text-xs text-slate-500">Release sends the EFT. The bank then settles it or fails it.</p>
      </header>
      {items.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-slate-500">Nothing is waiting to be released.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-5 py-2.5">Vendor</th>
                <th className="px-5 py-2.5 text-right">Amount</th>
                <th className="px-5 py-2.5">Pay on</th>
                <th className="px-5 py-2.5">Scheduled / approved by</th>
                {showYourCheck && <th className="px-5 py-2.5">Can you release it?</th>}
                <th className="px-5 py-2.5">Who can release</th>
                {showActions && <th className="px-5 py-2.5 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map(({ row, blockers, releasers }) => {
                const { invoice, current } = row;
                const ok = blockers.length === 0;
                return (
                  <tr key={current.paymentId} className="align-top hover:bg-slate-50/60">
                    <td className="px-5 py-3.5">
                      <Link
                        href={`/payments/${invoice.invoiceId}`}
                        className="font-medium text-slate-900 hover:text-(--brim-link)"
                      >
                        {invoice.vendorName}
                      </Link>
                      <p className="text-xs text-slate-500">Invoice {invoice.vendorInvoiceNumber}</p>
                    </td>
                    <td className="px-5 py-3.5 text-right tabular-nums">
                      <p className="font-medium text-slate-900">
                        {formatMoneyWithCode(current.amountCents, current.currency)}
                      </p>
                      {current.currency !== "CAD" && (
                        <p className="text-xs text-slate-500">≈ {formatMoney(current.amountCadCents)} CAD</p>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-slate-700">{formatDate(current.scheduledDate)}</td>
                    <td className="px-5 py-3.5 text-xs text-slate-600">
                      <p>
                        <span className="text-slate-400">Scheduled:</span> {current.preparedBy.name}
                      </p>
                      <p className="mt-0.5">
                        <span className="text-slate-400">Approved:</span>{" "}
                        {invoice.approvedBy.map((p) => p.name).join(", ")}
                      </p>
                    </td>
                    {showYourCheck && (
                      <td className="max-w-72 px-5 py-3.5">
                        {ok ? (
                          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">
                            ✓ Can release
                          </span>
                        ) : (
                          <div className="space-y-1.5">
                            <div className="flex flex-wrap gap-1">
                              {blockers.map((b) =>
                                b.code === "NOT_A_RELEASER" ? null : (
                                  <span
                                    key={b.code}
                                    className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${CHIP[b.code].className}`}
                                  >
                                    {CHIP[b.code].label}
                                  </span>
                                ),
                              )}
                            </div>
                            {blockers.map((b) => (
                              <p key={b.code} className="text-xs text-slate-600">
                                {b.message}
                              </p>
                            ))}
                          </div>
                        )}
                      </td>
                    )}
                    <td className="px-5 py-3.5 text-xs">
                      {releasers.length ? (
                        <span className="text-slate-700">{releasers.map((u) => u.fullName).join(", ")}</span>
                      ) : (
                        <span className="font-medium text-red-700">Nobody available</span>
                      )}
                    </td>
                    {showActions && (
                      <td className="px-5 py-3.5 text-right">
                        {ok ? <ActionsSpot label="Release" /> : <span className="text-slate-300">—</span>}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
