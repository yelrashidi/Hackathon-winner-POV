import Link from "next/link";
import type { PaymentsView } from "../_lib/data";
import { needsAttention } from "../_lib/data";
import { addDays, formatMoney } from "../_lib/format";

/** `today` is passed in (read at request time by the page) so this component stays pure. */
export function SummaryCards({
  view,
  today,
  links,
}: {
  view: PaymentsView;
  today: string;
  /** Where each card links, only for pages the signed-in person can open. */
  links: { awaiting?: string; release?: string; attention?: string };
}) {
  const weekEnd = addDays(today, 6);
  const current = view.payments.map((p) => p.current);
  const sum = (list: typeof current) => list.reduce((s, p) => s + p.amountCadCents, 0);

  const scheduledThisWeek = current.filter(
    (p) => p.status === "scheduled" && p.scheduledDate >= today && p.scheduledDate <= weekEnd,
  );
  const released = current.filter((p) => p.status === "released");
  const attention = view.payments.filter(needsAttention);
  const awaitingCents = view.awaitingPayment.reduce((s, i) => s + i.totalCadCents, 0);

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Card
        label="Scheduled next 7 days"
        value={formatMoney(sum(scheduledThisWeek))}
        detail={`${scheduledThisWeek.length} payments · CAD`}
        href={links.release}
      />
      <Card
        label="Released, waiting for bank"
        value={formatMoney(sum(released))}
        detail={`${released.length} payments · CAD`}
      />
      <Card
        label="Awaiting payment"
        value={formatMoney(awaitingCents)}
        detail={`${view.awaitingPayment.length} approved invoices · CAD`}
        href={links.awaiting}
      />
      <Card
        label="Needs attention"
        value={String(attention.length)}
        detail="failed or on hold"
        alert={attention.length > 0}
        href={links.attention}
      />
    </div>
  );
}

function Card({
  label,
  value,
  detail,
  alert = false,
  href,
}: {
  label: string;
  value: string;
  detail: string;
  alert?: boolean;
  href?: string;
}) {
  const body = (
    <>
      <p className="flex items-center justify-between text-sm font-medium text-slate-500">
        {label}
        {href && <span className="text-slate-300 transition group-hover:text-(--brim-link)">→</span>}
      </p>
      <p
        className={`mt-2 font-(family-name:--brim-font-display) text-3xl font-extrabold tabular-nums tracking-tight ${alert ? "text-red-600" : "text-(--brim-heading)"}`}
      >
        {value}
      </p>
      <p className="mt-1 text-xs text-slate-500">{detail}</p>
    </>
  );
  const className = `group block rounded-xl border bg-white p-5 shadow-sm ${
    alert ? "border-red-200" : "border-slate-200"
  } ${href ? "transition hover:border-(--brim-accent) hover:shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--brim-link)" : ""}`;

  return href ? (
    <Link href={href} className={className}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}
