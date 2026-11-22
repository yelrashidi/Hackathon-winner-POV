import { getViewer } from "@/server/session/current-user";
import { roleInfo } from "@/server/session/roles";
import { countsFor } from "../_lib/counts";
import { labelOf, sectionsFor } from "../_lib/nav";
import { SidebarNav, type NavItem } from "./SidebarNav";

/** Only the screens the signed-in person's role includes, with what is waiting on each. */
export async function AppSidebar() {
  const viewer = await getViewer();
  const counts = viewer ? await countsFor(viewer) : {};
  const items: NavItem[] = sectionsFor(viewer?.role ?? null).map((s) => ({
    key: s.key,
    href: s.href,
    label: labelOf(s, viewer?.role ?? null),
    group: s.group,
    count: counts[s.key]?.n,
    alert: counts[s.key]?.alert,
  }));
  const info = viewer ? roleInfo(viewer.role) : null;

  return (
    <div className="space-y-6">
      {items.length > 0 ? <SidebarNav items={items} /> : <SidebarNav items={[{ key: "home", href: "/", label: "Choose who you are", group: null }]} />}
      <div className="hidden rounded-lg bg-white/5 p-3 ring-1 ring-white/10 lg:block">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-white/50">{info ? `As ${info.label}` : "Not signed in"}</p>
        <ul className="mt-2 space-y-1 text-xs text-(--brim-on-frame-muted)">
          {(info?.can ?? ["Pick who you are in the top-right, or on the home screen"]).map((a) => (
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
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="h-9 animate-pulse rounded-lg bg-white/10" />
      ))}
    </div>
  );
}
