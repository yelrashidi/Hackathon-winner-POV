import type { ChainStep } from "@/server/features/audit";
import { formatWhen } from "../_lib/format";
import { Card, Day, Pill } from "./ui";

// "Who did what": the people behind one invoice, top to bottom — requested, checked, approved,
// scheduled, released. Shown on the audit trail, the invoice record, and the Checks / Approvals /
// Payments screens while the invoice is in progress. Data: whoDidWhat() in features/audit.

const STEP_TITLE: Record<ChainStep["kind"], string> = { requested: "Requested", checked: "Checked", approved: "Approved", scheduled: "Scheduled", released: "Released" };
const STEP_DOT: Record<ChainStep["state"], string> = {
  done: "bg-emerald-500 ring-emerald-100",
  waiting: "bg-amber-400 ring-amber-100",
  not_yet: "bg-white ring-slate-200 border border-slate-300",
  not_recorded: "bg-slate-300 ring-slate-100",
  rejected: "bg-red-500 ring-red-100",
  failed: "bg-red-500 ring-red-100",
};
const STEP_NOTE: Partial<Record<ChainStep["state"], { label: string; tone: "amber" | "slate" | "red" }>> = {
  waiting: { label: "waiting", tone: "amber" },
  not_yet: { label: "not yet", tone: "slate" },
  not_recorded: { label: "not recorded", tone: "slate" },
  rejected: { label: "rejected", tone: "red" },
  failed: { label: "failed", tone: "red" },
};

/** The people chain, top to bottom: who requested, checked, approved, scheduled and released it. */
export function WhoDidWhat({ steps, title = "Who did what", description }: { steps: ChainStep[]; title?: string; description?: string }) {
  return (
    <Card title={title} description={description ?? "The people behind this invoice, in order. Separation of duties: a different person at each step that moves money."}>
      <ol className="relative">
        {steps.map((s, i) => {
          const note = STEP_NOTE[s.state];
          return (
            <li key={`${s.kind}-${i}`} className="relative flex gap-4 pb-5 last:pb-0">
              {i < steps.length - 1 && <span aria-hidden className="absolute left-[7px] top-4 h-full w-0.5 bg-slate-200" />}
              <span aria-hidden className={`relative mt-1 h-4 w-4 shrink-0 rounded-full ring-4 ${STEP_DOT[s.state]}`} />
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {STEP_TITLE[s.kind]}
                  {note && <Pill tone={note.tone}>{note.label}</Pill>}
                </p>
                <p className={`text-sm ${s.state === "done" ? "text-slate-900" : "text-slate-600"}`}>{s.summary}</p>
                {s.at && <p className="text-xs tabular-nums text-slate-500">{s.at.length === 10 ? <Day value={s.at} /> : formatWhen(s.at)}</p>}
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

