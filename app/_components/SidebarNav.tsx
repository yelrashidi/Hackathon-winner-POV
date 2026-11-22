"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { NavGroup, SectionKey } from "../_lib/nav";

export type NavItem = { key: SectionKey; href: string; label: string; group: NavGroup | null; count?: number; alert?: boolean };

// Simple 20×20 outline paths.
const ICONS: Record<SectionKey, string> = {
  home: "M3 10.5 10 4l7 6.5M5 9v7h4v-4h2v4h4V9",
  inbox: "M3 11h4l1.5 2h3L13 11h4M4 5h12l1 6v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-4l1-6Z",
  checks: "M7 10l2 2 4-4M5 3h10a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z",
  upload: "M10 13V3m0 0L6 7m4-4 4 4M4 13v2a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-2",
  duplicates: "M7 7V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-3M4 7h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z",
  approvals: "M4 10.5 8 14l8-8M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z",
  payments: "M3 6h14v9H3zM3 9h14M6 13h3",
  "to-schedule": "M6 3v2m8-2v2M4 7h12M5 5h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm3 6h4m-2-2v4",
  "to-release": "M3 10h11m-4-4 4 4-4 4M17 4v12",
  "needs-attention": "M10 7v4m0 3h.01M8.6 3.8 2.9 14a1.6 1.6 0 0 0 1.4 2.4h11.4a1.6 1.6 0 0 0 1.4-2.4L11.4 3.8a1.6 1.6 0 0 0-2.8 0Z",
  vendors: "M3 17V7l7-4 7 4v10M7 17v-5h6v5",
  audit: "M5 3h7l3 3v11H5V3Zm7 0v3h3M8 10h4M8 13h4",
  admin: "M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM10 2v2m0 12v2m8-8h-2M4 10H2m13.66-5.66-1.42 1.42M5.76 14.24l-1.42 1.42m11.32 0-1.42-1.42M5.76 5.76 4.34 4.34",
};

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  if (href === "/payments" || href === "/checks") return pathname === href || (pathname.startsWith(`${href}/`) && !/\/(to-|needs-|upload|duplicates)/.test(pathname.slice(href.length)));
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SidebarNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  const groups: (NavGroup | null)[] = [];
  for (const i of items) if (!groups.includes(i.group)) groups.push(i.group);

  return (
    <nav className="flex gap-4 overflow-x-auto lg:flex-col lg:gap-5" aria-label="Main">
      {groups.map((g) => (
        <div key={g ?? "top"} className="flex shrink-0 gap-1 lg:flex-col">
          {g && <p className="hidden px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-white/45 lg:block">{g}</p>}
          {items
            .filter((i) => i.group === g)
            .map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <Link
                  key={item.key}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`relative flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--brim-accent) ${
                    active ? "bg-(--brim-frame-active) text-(--brim-on-frame)" : "text-(--brim-on-frame-muted) hover:bg-(--brim-frame-active)/60 hover:text-(--brim-on-frame)"
                  }`}
                >
                  {active && <span className="absolute inset-y-2 left-0 w-1 rounded-full bg-(--brim-accent)" aria-hidden />}
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={`h-4 w-4 shrink-0 ${active ? "text-(--brim-accent)" : "text-white/40"}`} aria-hidden>
                    <path d={ICONS[item.key]} />
                  </svg>
                  <span className="flex-1 whitespace-nowrap">{item.label}</span>
                  {item.count !== undefined && item.count > 0 && (
                    <span className={`rounded-full px-2 text-xs font-semibold tabular-nums ${item.alert ? "bg-red-500 text-white" : "bg-white/10 text-white/80"}`}>{item.count}</span>
                  )}
                </Link>
              );
            })}
        </div>
      ))}
    </nav>
  );
}
