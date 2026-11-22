"use client";

import { useActionState } from "react";
import type { FormState } from "../../_lib/form";
import { fieldClass } from "../../_lib/styles";
import { decideAction } from "../actions";

/** Approve or reject, acknowledging each exception the plan lists. The server re-checks everything. */
export function DecisionForm({ invoiceId, attention, onBehalfOf }: { invoiceId: string; attention: { code: string; message: string }[]; onBehalfOf: string | null }) {
  const [state, run, pending] = useActionState<FormState, FormData>(decideAction, null);
  return (
    <form action={run} className="space-y-3">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      {onBehalfOf && <p className="rounded-md bg-violet-50 px-3 py-2 text-sm text-violet-900">You are signing on behalf of {onBehalfOf}, who is on leave. The audit trail records both of you.</p>}
      {attention.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">Acknowledge before approving</legend>
          {attention.map((a) => (
            <label key={a.code} className="flex items-start gap-2 text-sm text-slate-700">
              <input type="checkbox" name="ack" value={a.code} className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-(--brim-link)" />
              <span>
                <span className="font-mono text-xs text-slate-500">{a.code}</span> {a.message}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <textarea name="comment" rows={2} placeholder="Comment (required to reject)" className={fieldClass} />
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          name="decision"
          value="approve"
          disabled={pending}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 disabled:opacity-60"
        >
          {pending ? "…" : "Approve"}
        </button>
        <button
          type="submit"
          name="decision"
          value="reject"
          disabled={pending}
          className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-rose-700 ring-1 ring-inset ring-rose-300 hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 disabled:opacity-60"
        >
          Reject
        </button>
      </div>
      {state && (
        <ul role={state.ok ? "status" : "alert"} className={`rounded-md px-3 py-2 text-sm ${state.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-800"}`}>
          {state.messages.map((m) => (
            <li key={m}>
              {state.ok ? "✓ " : "✗ "}
              {m}
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
