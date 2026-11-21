"use client";

import { useActionState, type ReactNode } from "react";
import type { FormState } from "./actions";

/** A form that runs one server action and shows its answer: green when done, red with every reason when refused. */
export function ActionForm({
  action,
  label,
  children,
  danger = false,
}: {
  action: (state: FormState, form: FormData) => Promise<FormState>;
  label: string;
  children?: ReactNode;
  danger?: boolean;
}) {
  const [state, run, pending] = useActionState(action, null);
  return (
    <form action={run} className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        {children}
        <button
          type="submit"
          disabled={pending}
          className={`rounded px-3 py-1 text-sm font-medium text-white disabled:opacity-50 ${danger ? "bg-red-700 hover:bg-red-800" : "bg-blue-700 hover:bg-blue-800"}`}
        >
          {pending ? "…" : label}
        </button>
      </div>
      {state && (
        <ul className={`rounded px-2 py-1 text-sm ${state.ok ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"}`}>
          {state.messages.map((m) => (
            <li key={m}>{state.ok ? "✓ " : "✗ "}{m}</li>
          ))}
        </ul>
      )}
    </form>
  );
}
