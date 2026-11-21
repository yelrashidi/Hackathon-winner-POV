"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { PageKey } from "../_lib/access";

export type NavItem = { key: PageKey; href: string; label: string; count?: number; alert?: boolean };

const ICONS: Record<PageKey, string> = {
  // Simple 20×20 outline paths.
  overview: "M3 10.5 10 4l7 6.5M5 9v7h4v-4h2v4h4V9",
  "to-schedule": "M6 3v2m8-2v2M4 7h12M5 5h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm3 6h4m-2-2v4",
  "to-release": "M3 10h11m-4-4 4 4-4 4M17 4v12",
  "needs-attention": "M10 7v4m0 3h.01M8.6 3.8 2.9 14a1.6 1.6 0 0 0 1.4 2.4h11.4a1.6 1.6 0 0 0 1.4-2.4L11.4 3.8a1.6 1.6 0 0 0-2.8 0Z",
};

export function SidebarNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  return (
    <nav className="flex gap-1 overflow-x-auto lg:flex-col" aria-label="Payments">
      {items.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.key}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              active ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200" : "text-slate-600 hover:bg-white/70 hover:text-slate-900"
            }`}
          >
            <svg
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`h-4 w-4 ${active ? "text-indigo-600" : "text-slate-400"}`}
              aria-hidden
            >
              <path d={ICONS[item.key]} />
            </svg>
            <span className="flex-1">{item.label}</span>
            {item.count !== undefined && (
              <span
                className={`rounded-full px-2 text-xs font-semibold tabular-nums ${
                  item.alert ? "bg-red-600 text-white" : "bg-slate-200/70 text-slate-600"
                }`}
              >
                {item.count}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
