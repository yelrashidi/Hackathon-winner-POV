import Link from "next/link";
import { listAuditInvoices } from "@/server/features/audit";
import { listApprovals } from "@/server/dashboard/approvals";
import { listChecks } from "@/server/dashboard/checks";
import { recentActivity } from "@/server/dashboard/records";
import { signInAs } from "@/server/session/actions";
import { getViewer, listSwitchableUsers, type Viewer } from "@/server/session/current-user";
import { APP_ROLES, appRoleOf, roleInfo } from "@/server/session/roles";
import { Card, EmptyState, InvoiceStatus, Money, PageHeader, Pill, StatCard, TextLink } from "./_components/ui";
import { countsFor } from "./_lib/counts";
import { ago, initials } from "./_lib/format";
import { canSee } from "./_lib/nav";

const FLAG_TONE = { block: "red", warn: "amber", info: "slate" } as const;

export default async function HomePage() {
  const viewer = await getViewer();
  return viewer ? <RoleHome viewer={viewer} /> : <ChooseWhoYouAre />;
}

// ---------------------------------------------------------------------------------------------
// Not signed in: one card per role, one click to sign in as someone in it
// ---------------------------------------------------------------------------------------------

async function ChooseWhoYouAre() {
  const people = await listSwitchableUsers();
  return (
    <>
      <PageHeader
        eyebrow="Harborline Logistics · accounts payable"
        title="Who are you today?"
        description="Every supplier bill goes inbox → checks → approval → payment → audit trail. Pick a person to see the app as their role. The role always comes from their employee record, on the server."
      />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {APP_ROLES.map((r) => {
          const members = people.filter((u) => appRoleOf(u.role) === r.key);
          return (
            <section key={r.key} className="flex flex-col rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="font-(family-name:--brim-font-display) text-lg font-extrabold text-(--brim-heading)">{r.label}</h2>
              <p className="mt-1 text-sm text-slate-600">{r.summary}</p>
              <ul className="mt-3 space-y-1 text-xs text-slate-500">
                {r.can.map((c) => (
                  <li key={c}>• {c}</li>
                ))}
              </ul>
              <form action={signInAs} className="mt-4 flex flex-col gap-2">
                {members.map((u) => (
                  <button
                    key={u.id}
                    type="submit"
                    name="userId"
                    value={u.id}
                    className="flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2 text-left text-sm transition-colors hover:border-(--brim-accent) hover:bg-(--brim-accent)/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--brim-link)"
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-(--brim-accent)/20 text-xs font-bold text-(--brim-link)">{initials(u.fullName)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-slate-900">{u.fullName}</span>
                      <span className="block truncate text-xs text-slate-500">
                        {u.title}
                        {u.status === "on_leave" ? " · on leave" : ""}
                      </span>
                    </span>
                    <span className="text-xs font-semibold text-(--brim-link)">Sign in →</span>
                  </button>
                ))}
              </form>
            </section>
          );
        })}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Signed in: what is waiting on you
// ---------------------------------------------------------------------------------------------

async function RoleHome({ viewer }: { viewer: Viewer }) {
  const { role, actor, user } = viewer;
  const info = roleInfo(role);
  const [counts, checks, approvals, activity, past] = await Promise.all([
    countsFor(viewer),
    canSee(role, "checks") ? listChecks(actor) : Promise.resolve([]),
    canSee(role, "approvals") ? listApprovals(actor) : Promise.resolve([]),
    recentActivity(actor, { limit: 8 }),
    role === "auditor" ? listAuditInvoices(actor, { pageSize: 1 }) : Promise.resolve(null),
  ]);
  const mine = approvals.filter((a) => a.mine);
  const byKind = (k: string) => checks.filter((c) => c.reasons[0]?.kind === k).length;

  return (
    <>
      <PageHeader eyebrow={info.label} title={`Hello, ${user.fullName.split(" ")[0]}`} description={info.summary} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {canSee(role, "approvals") && <StatCard label="Approvals waiting on you" value={mine.length} hint={`${approvals.length} in approval overall`} href="/approvals" tone={mine.length ? "alert" : "default"} />}
        {canSee(role, "checks") && <StatCard label="Checks to do" value={checks.length} hint={`${byKind("unreadable")} to type in · ${byKind("blocking")} blocked · ${byKind("ready") + byKind("confirm")} nearly ready`} href="/checks" />}
        {canSee(role, "to-schedule") && <StatCard label="Approved, to schedule" value={counts["to-schedule"]?.n ?? 0} href="/payments/to-schedule" />}
        {canSee(role, "to-release") && (
          <StatCard label={role === "admin" ? "Releases only you can do" : "Payments you can release"} value={counts["to-release"]?.n ?? 0} href="/payments/to-release" />
        )}
        {canSee(role, "needs-attention") && <StatCard label="Payments needing attention" value={counts["needs-attention"]?.n ?? 0} href="/payments/needs-attention" tone={counts["needs-attention"]?.n ? "alert" : "default"} />}
        {role === "auditor" && <StatCard label="Invoices on record" value={past?.total ?? 0} hint="Every one opens to its full audit trail" href="/audit" />}
        <StatCard label="Audit trail" value="Open" hint="Past invoices and who did what" href="/audit" />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-6">
          {mine.length > 0 && (
            <Card title="Waiting on your approval" action={<TextLink href="/approvals">All approvals →</TextLink>} padded={false}>
              <ul className="divide-y divide-slate-100">
                {mine.slice(0, 5).map((a) => (
                  <li key={a.invoiceId}>
                    <Link href={`/approvals/${a.invoiceId}`} className="flex items-center gap-4 px-5 py-3 hover:bg-slate-50">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-slate-900">{a.vendorName ?? a.invoiceId}</span>
                        <span className="block truncate text-xs text-slate-500">
                          Step {a.step.seq} of {a.step.of} · {a.step.reason}
                          {a.onBehalfOf ? ` · for ${a.onBehalfOf.name} (on leave)` : ""}
                        </span>
                      </span>
                      <Money cents={a.totalCents} currency={a.currency} cadCents={a.totalCadCents} className="text-sm font-medium" />
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {checks.length > 0 && (
            <Card title="Next checks" description="Most urgent first: what the machine couldn't read or code." action={<TextLink href="/checks">All checks →</TextLink>} padded={false}>
              <ul className="divide-y divide-slate-100">
                {checks.slice(0, 6).map((c) => (
                  <li key={c.invoiceId}>
                    <Link href={`/checks/${c.invoiceId}`} className="flex items-center gap-4 px-5 py-3 hover:bg-slate-50">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-slate-900">
                          {c.vendorName ?? "Unread document"}
                          {c.source === "email" && <span className="ml-2 text-xs font-normal text-slate-400">from email · {c.receivedDate}</span>}
                        </span>
                        <span className="block truncate text-xs text-slate-500">{c.reasons[0]?.label}</span>
                        {c.flagTags.length > 0 && (
                          <span className="mt-1 flex flex-wrap gap-1">
                            {c.flagTags.slice(0, 4).map((f) => (
                              <Pill key={f.code} tone={FLAG_TONE[f.severity]}>{f.code}</Pill>
                            ))}
                            {c.flagTags.length > 4 && <Pill>+{c.flagTags.length - 4}</Pill>}
                          </span>
                        )}
                      </span>
                      <InvoiceStatus status={c.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {role === "auditor" && (
            <Card title="Start here">
              <p className="text-sm text-slate-600">
                Open <TextLink href="/audit">the audit trail</TextLink> to see every past invoice. Each one shows the original document, what extraction read, the GL coding, every flag and who
                closed it, the approval chain (delegates included), the payment and the exact bank account it went to, and automatic control checks.
              </p>
            </Card>
          )}
          {mine.length === 0 && checks.length === 0 && role !== "auditor" && <EmptyState title="Nothing is waiting on you right now.">New bills arrive in the inbox and show up in Checks.</EmptyState>}
        </div>

        <Card title="Recent activity" description="Live actions in the app (history imported from the dataset is in the audit trail)." padded={false}>
          {activity.length === 0 ? (
            <p className="px-5 py-4 text-sm text-slate-500">Nothing yet. Actions people take appear here.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {activity.map((e) => (
                <li key={e.id} className="px-5 py-2.5 text-sm">
                  <p className="text-slate-800">
                    <span className="font-medium">{e.actor?.name ?? "System"}</span>
                    {e.onBehalfOf ? <span className="text-slate-500"> for {e.onBehalfOf.name}</span> : null} <Pill>{e.action}</Pill>
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {ago(e.at)}
                    {e.invoiceId ? (
                      <>
                        {" · "}
                        <TextLink href={`/audit/${e.invoiceId}`}>{e.invoiceId}</TextLink>
                      </>
                    ) : null}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
