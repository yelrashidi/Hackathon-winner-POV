"use client";

import { useActionState } from "react";
import { resetDemoAction, type ResetState } from "../demo/reset-action";

/** Demo controls → Start again (Admin only): rebuild the demo from the dataset, then go home. Asks first. */
export function ResetDemoButton() {
  const [state, action, pending] = useActionState<ResetState, FormData>(resetDemoAction, null);
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm("Reset the demo? Everything done in the app (uploads, Gmail bills, checks, approvals, payments, bank answers, journal exports) is erased and the dataset is loaded again.")) e.preventDefault();
      }}
    >
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-rose-700 ring-1 ring-inset ring-rose-300 hover:bg-rose-50 disabled:cursor-wait disabled:opacity-60"
      >
        {pending ? "Resetting… (a few seconds)" : "Reset demo data"}
      </button>
      {state && !state.ok && <p className="mt-2 text-xs text-rose-700">{state.message}</p>}
    </form>
  );
}
