"use client";

import { useEffect, useRef, useState } from "react";
import { switchViewingAs } from "@/server/session/actions";

export type SwitcherGroup = {
  label: string;
  people: { id: string; fullName: string; detail: string }[];
};

type Current = { id: string; fullName: string; roleLabel: string; viewOnly: boolean } | null;

export function UserSwitcherMenu({ current, groups }: { current: Current; groups: SwitcherGroup[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on a click outside or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2.5 rounded-lg border border-slate-200 bg-white py-1.5 pl-1.5 pr-3 text-left text-sm shadow-sm hover:border-slate-300 hover:bg-slate-50"
      >
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
            current ? "bg-indigo-100 text-indigo-700" : "bg-slate-100 text-slate-400"
          }`}
        >
          {current ? initials(current.fullName) : "?"}
        </span>
        <span className="leading-tight">
          <span className="block text-[11px] text-slate-500">Viewing as</span>
          <span className="block font-medium text-slate-900">
            {current ? (
              <>
                {current.fullName} <span className="font-normal text-slate-500">({current.roleLabel})</span>
              </>
            ) : (
              "Choose who you are"
            )}
          </span>
        </span>
        {(!current || current.viewOnly) && (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
            View only
          </span>
        )}
        <svg viewBox="0 0 20 20" fill="currentColor" className="ml-1 h-4 w-4 text-slate-400" aria-hidden>
          <path
            fillRule="evenodd"
            d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-2 max-h-[70vh] w-80 overflow-y-auto rounded-xl border border-slate-200 bg-white py-1 shadow-xl"
        >
          <p className="border-b border-slate-100 px-3 py-2 text-xs text-slate-500">
            Demo sign-in: pick a person. Their role comes from the employee record.
          </p>
          {/* One form, many submit buttons: the clicked button's userId is what gets sent. */}
          <form action={switchViewingAs} onSubmit={() => setOpen(false)}>
            {groups.map((g) => (
              <div key={g.label} className="py-1">
                <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  {g.label}
                </p>
                {g.people.map((p) => {
                  const selected = current?.id === p.id;
                  return (
                    <button
                      key={p.id}
                      type="submit"
                      name="userId"
                      value={p.id}
                      role="menuitem"
                      className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm hover:bg-slate-50 ${
                        selected ? "bg-indigo-50/60" : ""
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-slate-900">{p.fullName}</span>
                        <span className="block truncate text-xs text-slate-500">{p.detail}</span>
                      </span>
                      {selected && <span className="text-indigo-600">✓</span>}
                    </button>
                  );
                })}
              </div>
            ))}
            <div className="border-t border-slate-100 py-1">
              <button
                type="submit"
                name="userId"
                value=""
                role="menuitem"
                className="w-full px-3 py-2 text-left text-sm text-slate-600 hover:bg-slate-50"
              >
                Nobody (view only)
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function initials(name: string): string {
  return name
    .split(" ")
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
