import { Suspense } from "react";
import { cookies } from "next/headers";
import { FailureCode, type FlagUrgency, type PaymentFlag, type PaymentRow } from "@/contracts/payment";
import { getPaymentAudit, getSupplierBank, listPayments, listUsers } from "@/server/features/payments";
import { ActionForm } from "./action-form";
import {
  cancelAction,
  clearFlagAction,
  rejectBankAction,
  releaseAction,
  requestBankAction,
  resetDemo,
  scheduleAction,
  setViewer,
  settleAction,
  verifyBankAction,
} from "./actions";

// Payments console: the payment actions (schedule, release, cancel, simulated bank, retry, flags,
// bank change). The dashboard session's /payments pages show the same data; this page is where
// the payment session's buttons live until they're placed in the dashboard's Actions spots.

export default function Page() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6 font-sans text-zinc-900">
      <h1 className="text-2xl font-semibold">Payments console</h1>
      <Suspense fallback={<p>Loading…</p>}>
        <Console />
      </Suspense>
    </main>
  );
}

const ROLE_ORDER = ["ap_clerk", "finance_manager", "controller_admin", "auditor", "approver", "employee"];
const ROLE_LABEL: Record<string, string> = {
  ap_clerk: "AP Clerk", finance_manager: "Finance Manager", controller_admin: "Controller", auditor: "Auditor", approver: "Approver", employee: "Employee",
};
const URGENCY_STYLE: Record<FlagUrgency, string> = {
  critical: "bg-red-600 text-white",
  high: "bg-amber-400 text-amber-950",
  low: "bg-zinc-300 text-zinc-800",
};

function money(cents: number, currency: string) {
  const abs = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}$${Math.floor(abs / 100).toLocaleString("en-CA")}.${String(abs % 100).padStart(2, "0")} ${currency}`;
}

const label = (code: string) => code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, " ");

async function Console() {
  // TEMP: session — same cookie as the dashboard's "Viewing as" switcher.
  const viewerId = (await cookies()).get("hl_viewing_as")?.value ?? null;
  const users = listUsers().sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.id.localeCompare(b.id));
  const viewer = users.find((u) => u.id === viewerId);
  const view = await listPayments(viewerId);

  const open = new Map<string, PaymentFlag>();
  for (const row of view.payments) for (const f of row.flags) if (f.clearedAt === null) open.set(f.flagId, f);
  const count = (u: FlagUrgency) => [...open.values()].filter((f) => f.urgency === u).length;
  const rows = [...view.payments].sort((a, b) => urgencyRank(a) - urgencyRank(b));

  return (
    <>
      <section className="flex flex-wrap items-end gap-3 rounded border border-zinc-200 p-3">
        <form action={setViewer} className="flex items-end gap-2">
          <label className="flex flex-col text-sm">
            Viewing as
            <select name="userId" defaultValue={viewerId ?? ""} className="rounded border px-2 py-1">
              <option value="">Nobody (view only)</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.fullName} ({ROLE_LABEL[u.role]}){u.status !== "active" ? ` · ${u.status.replace("_", " ")}` : ""}
                </option>
              ))}
            </select>
          </label>
          <button className="rounded bg-zinc-800 px-3 py-1 text-sm text-white">Switch</button>
        </form>
        <span className="text-sm text-zinc-600">{viewer ? `${viewer.fullName} · ${ROLE_LABEL[viewer.role]}` : "Pick a person to act."}</span>
        <form action={resetDemo} className="ml-auto">
          <button className="rounded border px-3 py-1 text-sm">Reset demo data</button>
        </form>
      </section>

      <p className="text-sm font-medium" aria-label="Open flags">
        <span className="text-red-700">{count("critical")} critical</span> · <span className="text-amber-700">{count("high")} high</span> ·{" "}
        <span className="text-zinc-600">{count("low")} low</span>
      </p>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Awaiting payment</h2>
        {view.awaitingPayment.length === 0 && <p className="text-sm text-zinc-500">Nothing approved is waiting.</p>}
        {view.awaitingPayment.map((inv) => (
          <div key={inv.invoiceId} className="flex flex-col gap-2 rounded border border-zinc-200 p-3">
            <div className="text-sm">
              <b>{inv.vendorName}</b> · invoice {inv.vendorInvoiceNumber} ({inv.invoiceId}) · {money(inv.totalCents, inv.currency)} · due {inv.dueDate}
            </div>
            <ActionForm action={scheduleAction} label="Schedule">
              <input type="hidden" name="invoiceId" value={inv.invoiceId} />
              <label className="text-sm">
                Pay date <input type="date" name="payDate" className="rounded border px-1" /> <span className="text-zinc-500">(empty = due date)</span>
              </label>
            </ActionForm>
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Payments</h2>
        {rows.map((row) => (
          <PaymentCard key={row.invoice.invoiceId} row={row} viewerId={viewerId} />
        ))}
      </section>
    </>
  );
}

function urgencyRank(row: PaymentRow): number {
  const openFlags = row.flags.filter((f) => f.clearedAt === null);
  if (openFlags.some((f) => f.urgency === "critical")) return 0;
  if (openFlags.some((f) => f.urgency === "high")) return 1;
  if (openFlags.some((f) => f.urgency === "low") || row.current.status === "failed") return 2;
  return 3;
}

function PaymentCard({ row, viewerId }: { row: PaymentRow; viewerId: string | null }) {
  const p = row.current;
  const canAct = p.status === "scheduled" || p.status === "on_hold";
  const bank = getSupplierBank(viewerId, row.invoice.vendorId);
  const pending = bank.find((b) => b.status === "pending");
  const needsBank = p.failure?.retryRule === "FIX_BANK_DETAILS" || !bank.some((b) => b.status === "verified");
  const trail = getPaymentAudit(viewerId, row.invoice.invoiceId);

  return (
    <article className="flex flex-col gap-2 rounded border border-zinc-300 p-3">
      <header className="flex flex-wrap items-center gap-2 text-sm">
        <b>{row.invoice.vendorName}</b>
        <span>invoice {row.invoice.vendorInvoiceNumber} ({row.invoice.invoiceId})</span>
        <span>{money(p.amountCents, p.currency)}</span>
        {p.currency !== "CAD" && <span className="text-zinc-500">= {money(p.amountCadCents, "CAD")}</span>}
        <span className="rounded bg-zinc-100 px-2">{label(p.status)}</span>
        <span>pay date {p.scheduledDate}</span>
        <span>to ••{p.bankAccount.last4}</span>
        <span className="text-zinc-500">invoice {row.invoice.status}</span>
      </header>

      <div className="text-sm text-zinc-600">
        {row.attempts.map((a) => `Attempt ${a.attemptNo}: ${label(a.status)}${a.failure ? `, ${label(a.failure.code).toLowerCase()}` : ""}`).join(" · ")}
        {" — "}scheduled by {p.preparedBy.name}{p.releasedBy ? `, released by ${p.releasedBy.name}` : ""} · approved by{" "}
        {row.invoice.approvedBy.map((x) => x.name).join(", ") || "nobody"} · requested by {row.invoice.requestedBy.name}
      </div>

      {p.failure && (
        <div className="rounded bg-red-50 p-2 text-sm text-red-900">
          <b>Failed: {p.failure.message}</b> Next step: {p.failure.nextStep}
        </div>
      )}
      {p.holdReason && <div className="rounded bg-red-50 p-2 text-sm text-red-900">On hold: {p.holdReason}</div>}

      {row.flags.map((f) => (
        <div key={f.flagId} className="flex flex-col gap-1 rounded border border-zinc-200 p-2 text-sm">
          <div className="flex items-center gap-2">
            <span className={`rounded px-2 text-xs font-semibold uppercase ${URGENCY_STYLE[f.urgency]}`}>{f.urgency}</span>
            <span>{f.message}</span>
            {f.clearedAt && (
              <span className="text-zinc-500">
                cleared {f.clearedAutomatically ? "automatically" : `by ${f.clearedBy?.name}`} {f.clearedAt.slice(0, 16).replace("T", " ")}
                {f.clearNote ? ` — "${f.clearNote}"` : ""}
              </span>
            )}
          </div>
          {!f.clearedAt && (
            <ActionForm action={clearFlagAction} label="Clear flag">
              <input type="hidden" name="flagId" value={f.flagId} />
              <input name="note" placeholder={f.urgency === "low" ? "Note (optional)" : "Note (required)"} className="w-72 rounded border px-1" />
            </ActionForm>
          )}
        </div>
      ))}

      {canAct && !row.releaseCheck.allowed && (
        <div className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-900">
          <b>You can&apos;t release this because:</b>
          <ul className="list-disc pl-5">
            {row.releaseCheck.reasons.map((r) => (
              <li key={r.code + r.message}>{r.message}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap gap-4">
        {canAct && (
          <ActionForm action={releaseAction} label="Release">
            <input type="hidden" name="paymentId" value={p.paymentId} />
          </ActionForm>
        )}
        {canAct && (
          <ActionForm action={cancelAction} label="Cancel payment" danger>
            <input type="hidden" name="paymentId" value={p.paymentId} />
            <input name="reason" placeholder="Reason (required)" className="w-56 rounded border px-1 text-sm" />
          </ActionForm>
        )}
        {p.status === "released" && (
          <ActionForm action={settleAction} label="Simulate bank answer">
            <input type="hidden" name="paymentId" value={p.paymentId} />
            <select name="outcome" className="rounded border px-1 text-sm">
              <option value="SETTLED">Settled</option>
              {FailureCode.options.map((c) => (
                <option key={c} value={c}>Fail: {label(c)}</option>
              ))}
            </select>
          </ActionForm>
        )}
        {(p.status === "failed" || p.status === "cancelled") && (
          <ActionForm action={scheduleAction} label="Retry (new attempt)">
            <input type="hidden" name="invoiceId" value={row.invoice.invoiceId} />
          </ActionForm>
        )}
      </div>

      <details className="text-sm">
        <summary className="cursor-pointer">Supplier bank details</summary>
        <ul className="pl-4">
          {bank.map((b) => (
            <li key={b.version}>
              v{b.version} ••{b.last4} {b.currency} — <b>{b.status}</b>
              {b.changedAt ? ` · changed ${b.changedAt}` : ""}
              {b.channel ? ` by ${b.channel.replace(/_/g, " ")}` : ""}
              {b.requestedBy ? ` · entered by ${b.requestedBy.name}` : ""}
              {b.verifiedBy ? ` · verified by ${b.verifiedBy.name}` : ""}
            </li>
          ))}
        </ul>
        {pending && (
          <div className="flex flex-wrap gap-4 pt-2">
            <ActionForm action={verifyBankAction} label={`Verify ••${pending.last4}`}>
              <input type="hidden" name="vendorId" value={row.invoice.vendorId} />
            </ActionForm>
            <ActionForm action={rejectBankAction} label={`Reject ••${pending.last4}`} danger>
              <input type="hidden" name="vendorId" value={row.invoice.vendorId} />
              <input name="reason" placeholder="Reason" className="w-48 rounded border px-1" />
            </ActionForm>
          </div>
        )}
        {needsBank && !pending && (
          <div className="pt-2">
            <ActionForm action={requestBankAction} label="Save new bank details">
              <input type="hidden" name="vendorId" value={row.invoice.vendorId} />
              <input name="institution" placeholder="Institution (3)" className="w-28 rounded border px-1" />
              <input name="transit" placeholder="Transit (5)" className="w-28 rounded border px-1" />
              <input name="account" placeholder="Account (7–12)" className="w-36 rounded border px-1" />
            </ActionForm>
          </div>
        )}
      </details>

      <details className="text-sm">
        <summary className="cursor-pointer">Audit trail ({trail.length})</summary>
        <ul className="pl-4 font-mono text-xs">
          {trail.map((e) => (
            <li key={e.id}>
              {e.occurredAt.slice(0, 19).replace("T", " ")} · {e.actorId} · {e.action}
              {e.reason ? ` — ${e.reason}` : ""}
            </li>
          ))}
        </ul>
      </details>
    </article>
  );
}
