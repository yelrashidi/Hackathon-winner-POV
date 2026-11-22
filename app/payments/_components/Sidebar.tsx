import { connection } from "next/server";
import { getCurrentUser } from "@/server/session/current-user";
import { dashboardRole, pagesFor, ROLE_ABILITIES, type PageKey } from "../_lib/access";
import { getPayments, needsAttention } from "../_lib/data";
import { openDuplicateCount } from "../_lib/duplicates";
import { SidebarNav, type NavItem } from "./SidebarNav";

/** Only the pages the signed-in person's role includes, with a count on each queue. */
export async function Sidebar() {
  await connection(); // request time: the counts read the database
  const [user, view, duplicates] = await Promise.all([getCurrentUser(), getPayments(), openDuplicateCount()]);
  const role = dashboardRole(user);

  const counts: Partial<Record<PageKey, number>> = {
    "to-schedule": view.awaitingPayment.length,
    "to-release": view.payments.filter((p) => p.current.status === "scheduled").length,
    "needs-attention": view.payments.filter(needsAttention).length,
    duplicates: duplicates ?? undefined,
  };

  const items: NavItem[] = pagesFor(role).map((p) => ({
    key: p.key,
    href: p.href,
    label: p.label,
    count: counts[p.key],
    alert: (p.key === "needs-attention" || p.key === "duplicates") && (counts[p.key] ?? 0) > 0,
  }));

  return (
    <div className="space-y-6">
      <SidebarNav items={items} />
      <div className="hidden rounded-lg bg-white/5 p-3 ring-1 ring-white/10 lg:block">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-white/50">
          {user ? "What you can do" : "Not signed in"}
        </p>
        <ul className="mt-2 space-y-1 text-xs text-(--brim-on-frame-muted)">
          {(user ? ROLE_ABILITIES[role] : ["Pick who you are in the top-right to act"]).map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function SidebarFallback() {
  return (
    <div className="space-y-2" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-9 animate-pulse rounded-lg bg-white/10" />
      ))}
    </div>
  );
}
