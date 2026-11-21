import type { PaymentStatus } from "../_lib/types";

type BadgeStatus = PaymentStatus | "awaiting";

const STYLES: Record<BadgeStatus, { label: string; className: string; dot: string }> = {
  awaiting: { label: "Awaiting payment", className: "bg-slate-100 text-slate-700 ring-slate-200", dot: "bg-slate-400" },
  scheduled: { label: "Scheduled", className: "bg-blue-50 text-blue-700 ring-blue-200", dot: "bg-blue-500" },
  released: { label: "Released", className: "bg-violet-50 text-violet-700 ring-violet-200", dot: "bg-violet-500" },
  settled: { label: "Settled", className: "bg-emerald-50 text-emerald-700 ring-emerald-200", dot: "bg-emerald-500" },
  failed: { label: "Failed", className: "bg-red-50 text-red-700 ring-red-200", dot: "bg-red-500" },
  on_hold: { label: "On hold", className: "bg-amber-50 text-amber-800 ring-amber-200", dot: "bg-amber-500" },
  cancelled: { label: "Cancelled", className: "bg-gray-100 text-gray-600 ring-gray-200", dot: "bg-gray-400" },
};

export function statusLabel(status: BadgeStatus): string {
  return STYLES[status].label;
}

export function StatusBadge({ status }: { status: BadgeStatus }) {
  const s = STYLES[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${s.className}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}
