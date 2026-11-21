import Link from "next/link";
import type { DashboardRole } from "../_lib/access";
import { canAct } from "../_lib/access";
import type { PaymentRow } from "../_lib/data";
import { FAILURE_REASONS, type FailureGroup } from "../_lib/failure-reasons";
import { formatDate, formatMoneyWithCode } from "../_lib/format";
import { actionFor, ActionsSpot } from "./ActionsSpot";

const TAGS: Record<FailureGroup | "hold", { label: string; className: string }> = {
  retry: { label: "Can retry", className: "bg-amber-50 text-amber-800 ring-amber-200" },
  fix_bank_details: { label: "Fix bank details first", className: "bg-orange-50 text-orange-800 ring-orange-200" },
  escalate: { label: "Escalated to Controller", className: "bg-red-50 text-red-800 ring-red-200" },
  hold: { label: "On hold", className: "bg-amber-50 text-amber-800 ring-amber-200" },
};

const HOLD_NEXT_STEP =
  "Nothing to do on this payment. It can be released once the supplier's new bank details are verified by a second person.";

/** Failed and held payments, each with the reason in plain words and what to do next. */
export function NeedsAttention({
  rows,
  role,
  title = "Needs attention",
  description = "Failed or held payments. The supplier is still owed.",
  emptyText = "Nothing needs attention right now.",
}: {
  rows: PaymentRow[];
  role: DashboardRole;
  title?: string;
  description?: string;
  emptyText?: string;
}) {
  const showActions = canAct(role);

  return (
    <section className={`rounded-xl border bg-white shadow-sm ${rows.length ? "border-red-200" : "border-slate-200"}`}>
      <header className={`flex flex-wrap items-center gap-2 border-b px-5 py-3 ${rows.length ? "border-red-100" : "border-slate-100"}`}>
        <span className={`h-2 w-2 rounded-full ${rows.length ? "bg-red-500" : "bg-emerald-500"}`} />
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {rows.length > 0 && (
          <span className="rounded-full bg-red-600 px-2 text-xs font-semibold text-white">{rows.length}</span>
        )}
        <p className="ml-auto text-xs text-slate-500">{description}</p>
      </header>
      {rows.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-slate-500">{emptyText}</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {rows.map(({ invoice, current }) => {
            const reason = current.failureCode ? FAILURE_REASONS[current.failureCode] : null;
            const tag = current.status === "on_hold" ? TAGS.hold : reason ? TAGS[reason.group] : null;
            const message = current.status === "on_hold" ? current.holdReason : reason?.message;
            const nextStep = current.status === "on_hold" ? HOLD_NEXT_STEP : reason?.nextStep;
            const when =
              current.status === "on_hold" ? "held" : `failed ${formatDate(current.failedAt)}`;
            const action = reason?.group === "escalate" ? null : actionFor(role, current.status);

            return (
              <li key={current.paymentId} className="grid gap-3 px-5 py-4 sm:grid-cols-[1fr_auto] sm:gap-6">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/payments/${invoice.invoiceId}`}
                      className="font-medium text-slate-900 hover:text-(--brim-link)"
                    >
                      {invoice.vendorName}
                    </Link>
                    <span className="text-xs text-slate-500">
                      Invoice {invoice.vendorInvoiceNumber} · {when}
                    </span>
                    {tag && (
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tag.className}`}>
                        {tag.label}
                      </span>
                    )}
                  </div>
                  {message && <p className="mt-1 text-sm text-slate-700">{message}</p>}
                  {nextStep && (
                    <p className="mt-0.5 text-sm text-slate-500">
                      <span className="font-medium text-slate-700">Next step:</span> {nextStep}
                    </p>
                  )}
                </div>
                <div className="flex items-start gap-4 sm:flex-col sm:items-end sm:gap-2">
                  <p className="text-sm font-semibold tabular-nums text-slate-900">
                    {formatMoneyWithCode(current.amountCents, current.currency)}
                  </p>
                  {showActions && action && <ActionsSpot label={action} />}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
