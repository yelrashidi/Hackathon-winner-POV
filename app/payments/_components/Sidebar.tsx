import { getCurrentUser } from "@/server/session/current-user";
import { dashboardRole, pagesFor, ROLE_ABILITIES, type PageKey } from "../_lib/access";
import { getPayments, needsAttention } from "../_lib/data";
import { SidebarNav, type NavItem } from "./SidebarNav";

/** Only the pages the signed-in person's role includes, with a count on each queue. */
export async function Sidebar() {
  const [user, view] = await Promise.all([getCurrentUser(), getPayments()]);
  const role = dashboardRole(user);

  const counts: Partial<Record<PageKey, number>> = {
    "to-schedule": view.awaitingPayment.length,
    "to-release": view.payments.filter((p) => p.current.status === "scheduled").length,
    "needs-attention": view.payments.filter(needsAttention).length,
  };

  const items: NavItem[] = pagesFor(role).map((p) => ({
    key: p.key,
    href: p.href,
    label: p.label,
    count: counts[p.key],
    alert: p.key === "needs-attention" && (counts["needs-attention"] ?? 0) > 0,
  }));

  return (
    <div className="space-y-6">
      <SidebarNav items={items} />
      <div className="hidden rounded-lg border border-slate-200 bg-white p-3 lg:block">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          {user ? "What you can do" : "Not signed in"}
        </p>
        <ul className="mt-2 space-y-1 text-xs text-slate-600">
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
        <div key={i} className="h-9 animate-pulse rounded-lg bg-slate-200/60" />
      ))}
    </div>
  );
}
