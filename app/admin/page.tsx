import type { Metadata } from "next";
import Link from "next/link";
import type { ApprovalPolicy } from "@/contracts/approvals";
import { listDirectory, listPolicies } from "@/server/pipeline";
import { getViewer, listSwitchableUsers } from "@/server/session/current-user";
import { appRoleOf, roleInfo } from "@/server/session/roles";
import { ActionForm } from "../_components/ActionForm";
import { inputClass } from "../_lib/styles";
import { NotForYourRole } from "../_components/NotForYourRole";
import { Card, PageHeader, Pill, Table, td } from "../_components/ui";
import { centsToInput, first, formatCents, formatWhen } from "../_lib/format";
import { canSee } from "../_lib/nav";
import { availabilityAction, policyAction } from "./actions";

export const metadata: Metadata = { title: "People & policies" };

function describe(p: ApprovalPolicy): string {
  const c = p.conditions;
  const when =
    c.kind === "amount_up_to" ? `Up to ${formatCents(c.cadCents)} CAD`
    : c.kind === "amount_over" ? `Over ${formatCents(c.cadCents)} CAD`
    : c.kind === "vendor_new_or_pending" ? `Vendor new (≤ ${c.newVendorDays} days) or pending review`
    : c.kind === "vendor_category" ? `Vendor category is ${c.category}`
    : c.kind === "flag_raised" ? `Flag ${c.code} raised`
    : c.kind.replace(/_/g, " ");
  const s = p.steps;
  const then =
    s.type === "chain" ? s.roles.join(" → ").replace(/_/g, " ")
    : s.type === "add_step" ? `+ ${s.role.replace(/_/g, " ")} step`
    : s.type === "release_by" ? `released by ${s.role.replace(/_/g, " ")}`
    : s.type.replace(/_/g, " ");
  return `${when} → ${then}`;
}

export default async function AdminPage({ searchParams }: PageProps<"/admin">) {
  const viewer = await getViewer();
  if (!canSee(viewer?.role ?? null, "admin")) return <NotForYourRole sectionKey="admin" viewer={viewer} />;
  const [policies, directory, cast, params] = await Promise.all([listPolicies(), listDirectory(), listSwitchableUsers(), searchParams]);
  // The demo cast only (one person per role); the rest of the company stays in the database.
  const people = directory.filter((u) => cast.some((c) => c.id === u.id));
  const tab = first(params.tab) === "people" ? "people" : "policies";
  const approvers = people.filter((u) => appRoleOf(u.role) && u.role !== "auditor" && u.role !== "ap_clerk");
  const active = people.filter((u) => u.status === "active");

  return (
    <>
      <PageHeader title="People & policies" description="The rules approvals routes by, and who is available to approve. Every change is a new version or an audited event, so a past approval always shows the rule and the people it was made under." />
      <nav className="flex gap-2" aria-label="Admin views">
        {[
          { key: "policies", label: "Approval policies" },
          { key: "people", label: "People" },
        ].map((t) => (
          <Link key={t.key} href={t.key === "policies" ? "/admin" : "/admin?tab=people"} aria-current={tab === t.key ? "page" : undefined} className={`rounded-full px-3 py-1 text-sm font-medium ring-1 ring-inset ${tab === t.key ? "bg-(--brim-frame) text-white ring-(--brim-frame)" : "bg-white text-slate-700 ring-slate-200"}`}>
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === "policies" ? (
        <div className="space-y-4">
          {(["approval", "match", "payment_release"] as const).map((type) => (
            <Card key={type} title={type === "approval" ? "Approval routing" : type === "match" ? "Matching" : "Payment release"} padded={false}>
              <ul className="divide-y divide-slate-100">
                {policies
                  .filter((p) => p.ruleType === type)
                  .map((p) => {
                    const amount = p.conditions.kind === "amount_up_to" || p.conditions.kind === "amount_over";
                    return (
                      <li key={p.id} className="px-5 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-sm font-semibold text-slate-900">{p.id}</span>
                          <span className="text-xs text-slate-500">v{p.version} · priority {p.priority}</span>
                          <Pill tone={p.active ? "emerald" : "slate"}>{p.active ? "active" : "inactive"}</Pill>
                          <span className="ml-auto text-xs text-slate-400">edited {formatWhen(p.editedAt)}</span>
                        </div>
                        <p className="mt-1 text-sm text-slate-800">{describe(p)}</p>
                        <p className="text-xs text-slate-500">{p.description}</p>
                        <details className="mt-2">
                          <summary className="cursor-pointer text-xs font-medium text-(--brim-link)">Edit</summary>
                          <div className="mt-2">
                            <ActionForm action={policyAction} label="Save new version" hidden={{ policyId: p.id, activeField: "1" }}>
                              {amount && <input name="amount" defaultValue={centsToInput((p.conditions as { cadCents: number }).cadCents)} aria-label="Threshold (CAD)" className={`w-32 ${inputClass}`} />}
                              {p.conditions.kind === "vendor_new_or_pending" && <input name="days" type="number" min={1} defaultValue={p.conditions.newVendorDays} aria-label="Days" className={`w-24 ${inputClass}`} />}
                              <select name="active" defaultValue={p.active ? "1" : "0"} aria-label="Active" className={inputClass}>
                                <option value="1">Active</option>
                                <option value="0">Inactive</option>
                              </select>
                              <input name="note" required placeholder="Why (required)" aria-label="Note" className={`w-56 ${inputClass}`} />
                            </ActionForm>
                          </div>
                        </details>
                      </li>
                    );
                  })}
              </ul>
            </Card>
          ))}
        </div>
      ) : (
        <Table head={["Person", "Role", "Approval limit", "Status", "Delegate", "Change"]}>
          {people.map((u) => {
            const role = appRoleOf(u.role);
            return (
              <tr key={u.id} className="hover:bg-slate-50/70">
                <td className={td}>
                  <p className="font-medium text-slate-900">{u.fullName}</p>
                  <p className="text-xs text-slate-500">
                    {u.id} · {u.title}
                  </p>
                </td>
                <td className={`${td} text-sm`}>{role ? roleInfo(role).label : <span className="text-slate-500">Employee (requester)</span>}</td>
                <td className={`${td} text-sm tabular-nums`}>{u.approvalLimitCents ? `${formatCents(u.approvalLimitCents)} CAD` : "—"}</td>
                <td className={td}>
                  <Pill tone={u.status === "active" ? "emerald" : u.status === "on_leave" ? "amber" : "slate"}>{u.status.replace("_", " ")}</Pill>
                </td>
                <td className={`${td} text-sm text-slate-600`}>{u.delegateId ? (people.find((p) => p.id === u.delegateId)?.fullName ?? u.delegateId) : "—"}</td>
                <td className={td}>
                  {u.status !== "terminated" && approvers.some((a) => a.id === u.id) && (
                    <ActionForm action={availabilityAction} label="Save" hidden={{ userId: u.id }} tone="quiet">
                      <select name="status" defaultValue={u.status === "on_leave" ? "active" : "on_leave"} aria-label="Status" className={inputClass}>
                        <option value="on_leave">On leave</option>
                        <option value="active">Back / active</option>
                      </select>
                      <select name="delegateId" defaultValue={u.delegateId ?? ""} aria-label="Delegate" className={`max-w-40 ${inputClass}`}>
                        <option value="">Delegate…</option>
                        {active
                          .filter((a) => a.id !== u.id && approvers.some((x) => x.id === a.id))
                          .map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.fullName}
                            </option>
                          ))}
                      </select>
                      <input name="note" required placeholder="Note" aria-label="Note" className={`w-28 ${inputClass}`} />
                    </ActionForm>
                  )}
                </td>
              </tr>
            );
          })}
        </Table>
      )}
    </>
  );
}
