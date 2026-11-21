import type { Metadata } from "next";
import { Nunito } from "next/font/google";
import Link from "next/link";
import { Suspense } from "react";
import { Sidebar, SidebarFallback } from "./_components/Sidebar";
import { UserSwitcher } from "./_components/UserSwitcher";
import "./brim-theme.css";

// Bold rounded display face for page titles and summary numbers. Body text stays Geist.
const display = Nunito({ subsets: ["latin"], weight: ["700", "800"], variable: "--font-brim-display" });

export const metadata: Metadata = {
  title: { default: "Payments · Brim AP", template: "%s · Brim AP" },
};

// The frame (blue top bar and sidebar) is static and loads instantly. Everything that depends on
// who is signed in (the switcher, the sidebar links, each page) reads the cookie inside a
// <Suspense> boundary, as Cache Components requires.
export default function PaymentsLayout({ children }: LayoutProps<"/payments">) {
  return (
    <div
      className={`brim-theme ${display.variable} flex min-h-screen w-full flex-col bg-(--brim-surface) font-sans text-slate-900`}
    >
      <header className="sticky top-0 z-20 bg-(--brim-frame) text-(--brim-on-frame)">
        <div className="flex h-16 items-center gap-4 px-4 sm:px-6">
          <Link
            href="/payments"
            className="rounded font-(family-name:--brim-font-display) text-xl font-extrabold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--brim-accent)"
          >
            Brim AP
          </Link>
          <span className="hidden border-l border-white/15 pl-4 text-sm text-(--brim-on-frame-muted) sm:inline">
            Harborline Logistics
          </span>
          {/* Demo control: the simulated bank's answer and a reset live on their own page. */}
          <Link
            href="/payments-console"
            className="hidden rounded-full bg-amber-400/15 px-2.5 py-0.5 text-xs font-medium text-amber-200 ring-1 ring-inset ring-amber-300/30 hover:bg-amber-400/25 md:inline"
          >
            Simulated bank (demo)
          </Link>
          <div className="ml-auto">
            <Suspense fallback={<SwitcherFallback />}>
              <UserSwitcher />
            </Suspense>
          </div>
        </div>
      </header>

      <div className="flex flex-1 flex-col lg:flex-row">
        {/* The aside stretches to full height so the blue column never ends early; its content sticks. */}
        <aside className="border-t border-white/10 bg-(--brim-frame) lg:w-60 lg:shrink-0">
          <div className="px-3 py-3 lg:sticky lg:top-16 lg:py-5">
            <Suspense fallback={<SidebarFallback />}>
              <Sidebar />
            </Suspense>
          </div>
        </aside>
        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
          <div className="mx-auto max-w-6xl space-y-6">{children}</div>
        </main>
      </div>
    </div>
  );
}

function SwitcherFallback() {
  return <div className="h-11 w-56 animate-pulse rounded-lg bg-white/10" aria-hidden />;
}
