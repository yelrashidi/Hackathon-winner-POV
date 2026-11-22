"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * The download is a plain form POST (the browser saves the CSV and stays on the page). Afterwards
 * the page refreshes so the export shows in the history and the entries count as already exported.
 */
export function DownloadForm({ hidden, label, disabled }: { hidden: Record<string, string>; label: string; disabled: boolean }) {
  const router = useRouter();
  const [sent, setSent] = useState(false);
  return (
    <form
      method="post"
      action="/journal/export"
      onSubmit={() => {
        setSent(true);
        setTimeout(() => {
          router.refresh();
          setSent(false);
        }, 1500);
      }}
      className="flex flex-col items-end gap-1"
    >
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <button
        type="submit"
        disabled={disabled || sent}
        className="rounded-lg bg-(--brim-accent) px-4 py-2 text-sm font-semibold text-(--brim-on-accent) hover:bg-(--brim-accent-hover) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--brim-link) focus-visible:ring-offset-2 disabled:opacity-50"
      >
        {sent ? "Preparing the file…" : label}
      </button>
      <span className="text-xs text-slate-500">Recorded in the audit trail; these entries then count as posted.</span>
    </form>
  );
}
