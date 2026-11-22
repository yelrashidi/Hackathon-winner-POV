"use client";

import { useActionState, type ReactNode } from "react";
import type { FormState } from "../_lib/form";

// One form = one server action. The button always works: if the rules say no, the server's
// reasons come back and show in red right under it (hiding a button is not the security).

const BUTTON = {
  primary: "bg-(--brim-accent) text-(--brim-on-accent) hover:bg-(--brim-accent-hover) focus-visible:ring-(--brim-link)",
  danger: "bg-rose-700 text-white hover:bg-rose-800 focus-visible:ring-rose-400",
  quiet: "bg-white text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 focus-visible:ring-(--brim-link)",
  success: "bg-emerald-600 text-white hover:bg-emerald-700 focus-visible:ring-emerald-400",
};

export function ActionForm({
  action,
  label,
  pendingLabel = "…",
  hidden = {},
  children,
  tone = "primary",
  align = "start",
  size = "sm",
  layout = "inline",
  confirm,
}: {
  action: (state: FormState, form: FormData) => Promise<FormState>;
  label: string;
  pendingLabel?: string;
  /** Ids the action needs (invoiceId, paymentId, flagId…). Never who is acting: the server knows. */
  hidden?: Record<string, string>;
  children?: ReactNode;
  tone?: keyof typeof BUTTON;
  align?: "start" | "end";
  size?: "sm" | "md";
  /** inline: fields and button on one row. stacked: fields above, button below. */
  layout?: "inline" | "stacked";
  /** Ask before sending (e.g. reject, reset). */
  confirm?: string;
}) {
  const [state, run, pending] = useActionState(action, null);
  const button = (
    <button
      type="submit"
      disabled={pending}
      className={`whitespace-nowrap rounded-md font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 disabled:opacity-60 ${size === "md" ? "px-4 py-2 text-sm" : "px-3 py-1.5 text-xs"} ${BUTTON[tone]}`}
    >
      {pending ? pendingLabel : label}
    </button>
  );
  return (
    <form
      action={run}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
      className={`flex flex-col gap-1.5 ${align === "end" ? "items-end" : "items-start"}`}
    >
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {layout === "stacked" ? (
        <div className="flex w-full flex-col gap-2">
          {children}
          <div>{button}</div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {children}
          {button}
        </div>
      )}
      {state && (
        <ul role={state.ok ? "status" : "alert"} className={`max-w-xl rounded-md px-2.5 py-1.5 text-left text-xs ${state.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-800"}`}>
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

