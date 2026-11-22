import type { DirectoryUser } from "@/server/session/users";
import type { PaymentRow } from "../_lib/data";
import { formatDate } from "../_lib/format";
import { paymentsDb } from "@/server/pipeline";
import { clearFlagAction } from "../actions";
import { ActionForm, inputClass } from "./ActionForm";
import type { PaymentFlag, FlagUrgency } from "@/contracts/payment";

// FlagUrgency colours per docs/payment-data.md: critical red, high amber, low grey.
const URGENCY: Record<FlagUrgency, { label: string; className: string }> = {
  critical: { label: "Critical", className: "bg-red-600 text-white ring-red-600" },
  high: { label: "High", className: "bg-amber-100 text-amber-900 ring-amber-300" },
  low: { label: "Low", className: "bg-slate-100 text-slate-700 ring-slate-300" },
};

export function FlagBadge({ urgency }: { urgency: FlagUrgency }) {
  const u = URGENCY[urgency];
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ring-1 ring-inset ${u.className}`}
    >
      <svg viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3" aria-hidden>
        <path d="M3 1.75a.75.75 0 0 1 1.5 0V2h7.25a.75.75 0 0 1 .6 1.2L10.69 5.5l1.66 2.3a.75.75 0 0 1-.6 1.2H4.5v5.25a.75.75 0 0 1-1.5 0V1.75Z" />
      </svg>
      {u.label}
    </span>
  );
}

/** "1 critical · 3 high · 0 low" — open flags only. */
export function FlagCounts({ counts }: { counts: Record<FlagUrgency, number> }) {
  return (
    <span className="text-sm text-slate-600">
      <span className={counts.critical ? "font-semibold text-red-700" : ""}>{counts.critical} critical</span> ·{" "}
      <span className={counts.high ? "font-semibold text-amber-800" : ""}>{counts.high} high</span> ·{" "}
      <span>{counts.low} low</span>
    </span>
  );
}

/** Every flag on a payment, open first then cleared; cleared ones greyed with who, when and the note. */
export async function FlagList({
  flags,
  user,
}: {
  flags: PaymentFlag[];
  /** The payment the flags are shown on (kept for callers; clearing rules come from the server). */
  row?: PaymentRow;
  user: DirectoryUser | null;
}) {
  if (flags.length === 0) return <p className="text-sm text-slate-500">No flags.</p>;
  // Who may clear each flag: the same rule clearFlag() enforces, asked of the server once per list.
  const clearable = await paymentsDb.canClearFlags(user?.id ?? null, flags.filter((f) => f.clearedAt === null).map((f) => f.flagId));
  const sorted = [...flags].sort((a, b) => Number(a.clearedAt !== null) - Number(b.clearedAt !== null));

  return (
    <ul className="space-y-3">
      {sorted.map((f) => {
        const cleared = f.clearedAt !== null;
        return (
          <li key={f.flagId} className={`flex flex-wrap items-start gap-3 text-sm ${cleared ? "opacity-60" : ""}`}>
            <FlagBadge urgency={f.urgency} />
            <div className="min-w-0 flex-1">
              <p className={cleared ? "text-slate-500 line-through" : "text-slate-900"}>{f.message}</p>
              <p className="mt-0.5 text-xs text-slate-500">
                Raised {formatDate(f.createdAt)}
                {cleared &&
                  (f.clearedAutomatically
                    ? ` · Cleared automatically ${formatDate(f.clearedAt)}`
                    : ` · Cleared by ${f.clearedBy?.name ?? "—"}, ${formatDate(f.clearedAt)}${f.clearNote ? `: ${f.clearNote}` : ""}`)}
              </p>
            </div>
            {clearable[f.flagId] && (
              <ActionForm action={clearFlagAction} label="Clear flag" hidden={{ flagId: f.flagId }} tone="quiet">
                <input
                  name="note"
                  aria-label="Note"
                  placeholder={f.urgency === "low" ? "Note (optional)" : "Note (required)"}
                  className={`w-56 ${inputClass}`}
                />
              </ActionForm>
            )}
          </li>
        );
      })}
    </ul>
  );
}
