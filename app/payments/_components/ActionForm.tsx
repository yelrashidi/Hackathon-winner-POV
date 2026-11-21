"use client";

import { useActionState, type ReactNode } from "react";
import type { FormState } from "../actions";

// One form = one server action. The button always works: if the rules say no, the server's
// reasons come back and show in red right under it (hiding a button is not the security).

const BUTTON = {
  primary:
    "bg-(--brim-accent) text-(--brim-on-accent) hover:bg-(--brim-accent-hover) focus-visible:ring-(--brim-link)",
  danger: "bg-rose-700 text-white hover:bg-rose-800 focus-visible:ring-rose-400",
  quiet: "bg-white text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 focus-visible:ring-(--brim-link)",
};

export function ActionForm({
  action,
  label,
  hidden = {},
  children,
  tone = "primary",
  align = "start",
}: {
  action: (state: FormState, form: FormData) => Promise<FormState>;
  label: string;
  /** Ids the action needs (invoiceId, paymentId, flagId…). Never who is acting: the server knows. */
  hidden?: Record<string, string>;
  children?: ReactNode;
  tone?: keyof typeof BUTTON;
  align?: "start" | "end";
}) {
  const [state, run, pending] = useActionState(action, null);
  return (
    <form action={run} className={`flex flex-col gap-1.5 ${align === "end" ? "items-end" : "items-start"}`}>
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <div className="flex flex-wrap items-center gap-2">
        {children}
        <button
          type="submit"
          disabled={pending}
          className={`whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 disabled:opacity-60 ${BUTTON[tone]}`}
        >
          {pending ? "…" : label}
        </button>
      </div>
      {state && (
        <ul
          role={state.ok ? "status" : "alert"}
          className={`max-w-80 rounded-md px-2.5 py-1.5 text-left text-xs ${state.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-800"}`}
        >
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

export const inputClass = "rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-900 placeholder:text-slate-400";
