import Link from "next/link";
import type { ReactNode } from "react";
import { formatCents, formatDay } from "../_lib/format";

// Small building blocks every screen shares, in the Brim theme (app/brim-theme.css).

export function PageHeader({ title, description, eyebrow, children }: { title: string; description?: ReactNode; eyebrow?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-(--brim-link)">{eyebrow}</div>}
        <h1 className="font-(family-name:--brim-font-display) text-[1.75rem] leading-tight font-extrabold tracking-tight text-(--brim-heading)">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-slate-500">{description}</p>}
      </div>
      {children}
    </div>
  );
}

export function Card({ title, description, action, children, className = "", padded = true }: { title?: ReactNode; description?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={`rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}>
      {(title || action) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold text-slate-900">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-slate-500">{description}</p>}
          </div>
          {action}
        </header>
      )}
      <div className={padded ? "p-5" : ""}>{children}</div>
    </section>
  );
}

const PILL = {
  slate: "bg-slate-100 text-slate-700 ring-slate-200",
  blue: "bg-blue-50 text-blue-700 ring-blue-200",
  sky: "bg-sky-50 text-sky-700 ring-sky-200",
  violet: "bg-violet-50 text-violet-700 ring-violet-200",
  emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  red: "bg-red-50 text-red-700 ring-red-200",
  teal: "bg-(--brim-accent)/15 text-(--brim-link) ring-(--brim-accent)/40",
} as const;
export type PillTone = keyof typeof PILL;

export function Pill({ tone = "slate", children, title }: { tone?: PillTone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${PILL[tone]}`}>
      {children}
    </span>
  );
}

const STATUS: Record<string, { label: string; tone: PillTone }> = {
  Received: { label: "Received", tone: "slate" },
  ManualEntry: { label: "Needs typing in", tone: "amber" },
  InReview: { label: "In review", tone: "blue" },
  OnHold: { label: "On hold", tone: "amber" },
  PendingApproval: { label: "In approval", tone: "violet" },
  Approved: { label: "Approved", tone: "emerald" },
  PaymentScheduled: { label: "Payment scheduled", tone: "sky" },
  Paid: { label: "Paid", tone: "emerald" },
  Voided: { label: "Voided", tone: "slate" },
  Closed: { label: "Closed", tone: "slate" },
};

export function invoiceStatusLabel(status: string): string {
  return STATUS[status]?.label ?? status;
}

export function InvoiceStatus({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, tone: "slate" as const };
  return <Pill tone={s.tone}>{s.label}</Pill>;
}

const SEVERITY: Record<string, { label: string; tone: PillTone }> = {
  block: { label: "Blocking", tone: "red" },
  warn: { label: "Warning", tone: "amber" },
  info: { label: "Info", tone: "slate" },
};

export function SeverityBadge({ severity }: { severity: string }) {
  const s = SEVERITY[severity] ?? { label: severity, tone: "slate" as const };
  return <Pill tone={s.tone}>{s.label}</Pill>;
}

const CONFIDENCE: Record<string, { label: string; tone: PillTone }> = {
  high: { label: "High", tone: "emerald" },
  medium: { label: "Medium", tone: "amber" },
  low: { label: "Low", tone: "red" },
  none: { label: "No suggestion", tone: "slate" },
};

export function ConfidenceBadge({ confidence }: { confidence: string }) {
  const c = CONFIDENCE[confidence] ?? { label: confidence, tone: "slate" as const };
  return <Pill tone={c.tone}>{c.label}</Pill>;
}

/** Money from integer cents, with its currency; USD shows its CAD equivalent when known. */
export function Money({ cents, currency, cadCents, className = "" }: { cents: number | null | undefined; currency?: string | null; cadCents?: number | null; className?: string }) {
  if (cents === null || cents === undefined) return <span className="text-slate-400">—</span>;
  return (
    <span className={`tabular-nums ${className}`}>
      {formatCents(cents)}
      {currency && <span className="ml-1 text-xs text-slate-500">{currency}</span>}
      {currency && currency !== "CAD" && cadCents !== null && cadCents !== undefined && <span className="ml-1 text-xs text-slate-500">({formatCents(cadCents)} CAD)</span>}
    </span>
  );
}

export function Day({ value }: { value: string | null | undefined }) {
  return <span className="whitespace-nowrap tabular-nums">{formatDay(value ?? null)}</span>;
}

export function KeyValues({ items, columns = 2 }: { items: { label: string; value: ReactNode; hint?: ReactNode }[]; columns?: 2 | 3 | 4 }) {
  const cols = columns === 4 ? "sm:grid-cols-2 lg:grid-cols-4" : columns === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2";
  return (
    <dl className={`grid gap-x-6 gap-y-3 ${cols}`}>
      {items.map((i) => (
        <div key={i.label} className="min-w-0">
          <dt className="text-xs font-medium text-slate-500">{i.label}</dt>
          <dd className="mt-0.5 truncate text-sm text-slate-900">{i.value}</dd>
          {i.hint && <dd className="mt-0.5 text-xs text-amber-700">{i.hint}</dd>}
        </div>
      ))}
    </dl>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white/60 px-6 py-10 text-center">
      <p className="text-sm font-semibold text-slate-700">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-slate-500">{children}</div>}
    </div>
  );
}

const NOTICE = {
  info: "border-sky-200 bg-sky-50 text-sky-900",
  warn: "border-amber-200 bg-amber-50 text-amber-900",
  danger: "border-red-200 bg-red-50 text-red-900",
  success: "border-emerald-200 bg-emerald-50 text-emerald-900",
} as const;

export function Notice({ tone = "info", title, children }: { tone?: keyof typeof NOTICE; title?: ReactNode; children?: ReactNode }) {
  return (
    <div className={`rounded-lg border px-4 py-3 text-sm ${NOTICE[tone]}`}>
      {title && <p className="font-semibold">{title}</p>}
      {children && <div className={title ? "mt-1" : ""}>{children}</div>}
    </div>
  );
}

export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="font-medium text-(--brim-link) hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--brim-link)">
      {children}
    </Link>
  );
}

export function StatCard({ label, value, hint, href, tone = "default" }: { label: string; value: ReactNode; hint?: ReactNode; href?: string; tone?: "default" | "alert" | "good" }) {
  const ring = tone === "alert" ? "ring-red-200" : tone === "good" ? "ring-emerald-200" : "ring-slate-200";
  const body = (
    <div className={`h-full rounded-xl bg-white p-4 shadow-sm ring-1 ${ring} ${href ? "transition-shadow hover:shadow-md" : ""}`}>
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className={`mt-1 font-(family-name:--brim-font-display) text-3xl font-extrabold tabular-nums ${tone === "alert" ? "text-red-700" : "text-(--brim-heading)"}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
  return href ? (
    <Link href={href} className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--brim-link)">
      {body}
    </Link>
  ) : (
    body
  );
}

/** A table that scrolls sideways on narrow screens instead of breaking the page. */
export function Table({ head, children, empty }: { head: ReactNode[]; children: ReactNode; empty?: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
      <table className="min-w-full divide-y divide-slate-100 text-sm">
        <thead className="bg-slate-50/80">
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col" className="whitespace-nowrap px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
      {empty}
    </div>
  );
}

export const td = "px-4 py-3 align-top";
