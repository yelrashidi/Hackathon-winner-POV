import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Sidebar, SidebarFallback } from "./_components/Sidebar";
import { UserSwitcher } from "./_components/UserSwitcher";

export const metadata: Metadata = {
  title: { default: "Payments · Harborline AP", template: "%s · Harborline AP" },
};

// The frame is static and loads instantly. Everything that depends on who is signed in (the
// switcher, the sidebar, each page) reads the cookie inside a <Suspense> boundary, as Cache
// Components requires.
export default function PaymentsLayout({ children }: LayoutProps<"/payments">) {
  return (
    // Light theme on purpose: this section sets its own background so OS dark mode doesn't turn it black.
    <div className="min-h-screen w-full bg-slate-50 font-sans text-slate-900">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-2.5 sm:px-6">
          <Link href="/payments" className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-sm font-bold text-white">
              H
            </span>
            <span className="leading-tight">
              <span className="block text-sm font-semibold">Harborline AP</span>
              <span className="block text-xs text-slate-500">Payments</span>
            </span>
          </Link>
          {/* TEMP: remove when getPayments() reads real data. */}
          <span className="ml-2 hidden rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-200 md:inline">
            Sample data, not real payments
          </span>
          <div className="ml-auto">
            <Suspense fallback={<SwitcherFallback />}>
              <UserSwitcher />
            </Suspense>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:flex-row lg:gap-8 lg:py-8">
        <aside className="lg:w-56 lg:shrink-0">
          <Suspense fallback={<SidebarFallback />}>
            <Sidebar />
          </Suspense>
        </aside>
        <main className="min-w-0 flex-1 space-y-6">{children}</main>
      </div>
    </div>
  );
}

function SwitcherFallback() {
  return <div className="h-11 w-56 animate-pulse rounded-lg bg-slate-100" aria-hidden />;
}
