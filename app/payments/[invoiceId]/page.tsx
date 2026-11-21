import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { getCurrentUser } from "@/server/session/current-user";
import { actionFor, ActionsSpot } from "../_components/ActionsSpot";
import { describeAttempt } from "../_components/PaymentsTable";
import { FlagList } from "../_components/Flags";
import { StatusBadge } from "../_components/StatusBadge";
import { canAct, dashboardRole } from "../_lib/access";
import { getInvoice, getPaymentRow } from "../_lib/data";
import { formatDate, formatMoney, formatMoneyWithCode } from "../_lib/format";
import { releaseBlockers, whoCanRelease } from "../_lib/release-check";
import type { InvoiceRecord, PaymentFlag, PaymentRecord } from "../_lib/types";

export const metadata: Metadata = { title: "Payment details" };

// The URL uses the invoice id: one page covers every payment attempt for that invoice,
// and a retry gets a new payment id.
export default async function PaymentDetailsPage({ params }: PageProps<"/payments/[invoiceId]">) {
  const { invoiceId } = await params;
  const id = decodeURIComponent(invoiceId);
  const [user, invoice, row] = await Promise.all([getCurrentUser(), getInvoice(id), getPaymentRow(id)]);
  if (!invoice) notFound();

  const role = dashboardRole(user);
  const current = row?.current ?? null;
  const status = current?.status ?? "awaiting";
  const action = canAct(role) ? actionFor(role, status) : null;

  return (
    <>
      <Link href="/payments" className="text-sm font-medium text-(--brim-link) hover:underline">
        ← All payments
      </Link>

      <section className="flex flex-wrap items-start justify-between gap-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div>
          <h1 className="font-(family-name:--brim-font-display) text-[1.75rem] leading-tight font-extrabold tracking-tight text-(--brim-heading)">
            {invoice.vendorName}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Invoice {invoice.vendorInvoiceNumber} · {invoice.invoiceId}
          </p>
        </div>
        <div className="text-right">
          <p className="font-(family-name:--brim-font-display) text-3xl font-extrabold tabular-nums tracking-tight text-(--brim-heading)">
            {formatMoneyWithCode(current?.amountCents ?? invoice.totalCents, current?.currency ?? invoice.currency)}
          </p>
          {(current?.currency ?? invoice.currency) !== "CAD" && (
            <p className="text-xs text-slate-500">
              ≈ {formatMoney(current?.amountCadCents ?? invoice.totalCadCents)} CAD
            </p>
          )}
          <div className="mt-2">
            <StatusBadge status={status} />
          </div>
        </div>
      </section>

      <StatusPanel invoice={invoice} current={current} action={action}>
        {row && current?.status === "scheduled" && (
          <ReleasePanel
            blockers={releaseBlockers(user, row)}
            isReleaser={role === "finance_manager" || role === "controller"}
            releasers={whoCanRelease(row).map((u) => u.fullName)}
            showAction={action === "Release"}
          />
        )}
      </StatusPanel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Payment">
          {current ? (
            <dl className="divide-y divide-slate-100 text-sm">
              <Item label="Method">{current.method}</Item>
              <Item label="Amount">{formatMoneyWithCode(current.amountCents, current.currency)}</Item>
              {current.currency !== "CAD" && (
                <Item label="In CAD">
                  {formatMoney(current.amountCadCents)} CAD at {current.fxRateToCad} (invoice-date rate)
                </Item>
              )}
              <Item label="Pay on">{formatDate(current.scheduledDate)}</Item>
              <Item label="Scheduled by">{current.preparedBy.name}</Item>
              <Item label="Released by">
                {current.releasedBy ? `${current.releasedBy.name}, ${formatDate(current.releasedAt)}` : "—"}
              </Item>
              {current.settledAt && <Item label="Settled">{formatDate(current.settledAt)}</Item>}
              <Item label="Payment ID">{current.paymentId}</Item>
            </dl>
          ) : (
            <p className="text-sm text-slate-500">No payment yet. This invoice is approved and waiting to be scheduled.</p>
          )}
        </Card>
        <Card title="Invoice">
          <dl className="divide-y divide-slate-100 text-sm">
            <Item label="Vendor">
              {invoice.vendorName} <span className="text-slate-400">({invoice.vendorId})</span>
            </Item>
            <Item label="Vendor invoice #">{invoice.vendorInvoiceNumber}</Item>
            <Item label="Total">{formatMoneyWithCode(invoice.totalCents, invoice.currency)}</Item>
            <Item label="Due">{formatDate(invoice.dueDate)}</Item>
            <Item label="Requested by">{invoice.requestedBy.name}</Item>
            <Item label="Approved by">{invoice.approvedBy.map((p) => p.name).join(", ")}</Item>
          </dl>
        </Card>
      </div>

      {row && (
        <Card title={`Flags (${row.flags.length})`} note="Open flags first. Cleared flags stay here, greyed, with who cleared them and why.">
          <FlagList flags={row.flags} row={row} user={user} />
        </Card>
      )}

      {row && (
        <Card title={`Payment attempts (${row.attempts.length})`}>
          <ol className="space-y-3">
            {row.attempts.map((a) => (
              <li key={a.paymentId} className="flex flex-wrap items-center gap-3 text-sm">
                <span className="w-20 font-medium text-slate-900">Attempt {a.attemptNo}</span>
                <StatusBadge status={a.status} />
                <span className="text-slate-600">{describeAttempt(a)}</span>
              </li>
            ))}
          </ol>
          {row.attempts.length > 1 && (
            <p className="mt-4 text-xs text-slate-500">
              A retry is a new attempt that is scheduled and released again, with every rule checked again. Failed
              attempts stay in the history.
            </p>
          )}
        </Card>
      )}

      <Card
        title="Audit trail"
        note="Sample, built from the payment records. The real one comes from the audit log (feature 8), with exact times."
      >
        <AuditTrail invoice={invoice} attempts={row?.attempts ?? []} flags={row?.flags ?? []} />
      </Card>
    </>
  );
}

/** What's going on with this payment right now, and what happens next. */
function StatusPanel({
  invoice,
  current,
  action,
  children,
}: {
  invoice: InvoiceRecord;
  current: PaymentRecord | null;
  action: string | null;
  children?: ReactNode;
}) {
  if (!current) {
    return (
      <Panel tone="slate" title="Approved, waiting to be scheduled">
        <p>
          Approved by {invoice.approvedBy.map((p) => p.name).join(", ")}. An AP Clerk or Controller schedules the
          payment next.
        </p>
        {action && <ActionsSpot label={action} />}
      </Panel>
    );
  }

  switch (current.status) {
    case "failed": {
      const reason = current.failure;
      return (
        <Panel tone="red" title={`Failed at the bank on ${formatDate(current.failedAt)}`}>
          {reason && <p>{reason.message}</p>}
          {reason && (
            <p>
              <span className="font-medium">Next step:</span> {reason.nextStep}
            </p>
          )}
          {action && reason?.retryRule !== "ESCALATE" && <ActionsSpot label={action} />}
        </Panel>
      );
    }
    case "on_hold":
      return (
        <Panel tone="amber" title="On hold">
          <p>{current.holdReason}</p>
        </Panel>
      );
    case "cancelled":
      return (
        <Panel tone="slate" title="Cancelled">
          <p>{current.cancelReason}</p>
        </Panel>
      );
    case "released":
      return (
        <Panel tone="violet" title="Released, waiting for the bank">
          <p>
            {current.releasedBy?.name} released it on {formatDate(current.releasedAt)}. The bank will settle it or
            report a failure.
          </p>
        </Panel>
      );
    case "settled":
      return (
        <Panel tone="emerald" title={`Paid on ${formatDate(current.settledAt)}`}>
          <p>The bank confirmed the supplier received the money.</p>
        </Panel>
      );
    case "scheduled":
      return <>{children}</>;
  }
}

function ReleasePanel({
  blockers,
  isReleaser,
  releasers,
  showAction,
}: {
  blockers: { code: string; message: string }[];
  isReleaser: boolean;
  releasers: string[];
  showAction: boolean;
}) {
  const ok = blockers.length === 0;
  const whoLine = (
    <p>
      <span className="font-medium">Who can release it:</span>{" "}
      {releasers.length ? releasers.join(", ") : "nobody available right now"}
    </p>
  );

  if (!isReleaser) {
    return (
      <Panel tone="blue" title="Scheduled, waiting to be released">
        <p>Only a Finance Manager or Controller can release payments.</p>
        {whoLine}
      </Panel>
    );
  }
  return ok ? (
    <Panel tone="emerald" title="You can release this payment">
      {whoLine}
      {showAction && <ActionsSpot label="Release" />}
    </Panel>
  ) : (
    <Panel tone="rose" title="You can't release this payment">
      <ul className="list-disc space-y-0.5 pl-5">
        {blockers.map((b) => (
          <li key={b.code}>{b.message}</li>
        ))}
      </ul>
      {whoLine}
    </Panel>
  );
}

const TONES = {
  slate: "border-slate-200 bg-slate-50 text-slate-700",
  blue: "border-blue-200 bg-blue-50 text-blue-900",
  violet: "border-violet-200 bg-violet-50 text-violet-900",
  emerald: "border-emerald-200 bg-emerald-50 text-emerald-900",
  amber: "border-amber-200 bg-amber-50 text-amber-900",
  red: "border-red-200 bg-red-50 text-red-900",
  rose: "border-rose-200 bg-rose-50 text-rose-900",
};

function Panel({ tone, title, children }: { tone: keyof typeof TONES; title: string; children: ReactNode }) {
  return (
    <section className={`space-y-2 rounded-xl border px-5 py-4 text-sm ${TONES[tone]}`}>
      <h2 className="font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Card({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="border-b border-slate-200 px-5 py-3">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {note && <p className="mt-0.5 text-xs text-slate-500">{note}</p>}
      </header>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-3 py-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-slate-900">{children}</dd>
    </div>
  );
}

type AuditEvent = { when: string | null; who: string; what: string; tone: "default" | "good" | "bad" | "warn" };

function auditEvents(invoice: InvoiceRecord, attempts: PaymentRecord[], flags: PaymentFlag[]): AuditEvent[] {
  const events: AuditEvent[] = [
    { when: null, who: invoice.requestedBy.name, what: "Requested the invoice", tone: "default" },
    ...invoice.approvedBy.map((p) => ({ when: null, who: p.name, what: "Approved the invoice", tone: "default" as const })),
  ];
  for (const a of attempts) {
    const n = attempts.length > 1 ? ` (attempt ${a.attemptNo})` : "";
    events.push({ when: null, who: a.preparedBy.name, what: `Scheduled the payment for ${formatDate(a.scheduledDate)}${n}`, tone: "default" });
    if (a.releasedAt && a.releasedBy) {
      events.push({ when: a.releasedAt, who: a.releasedBy.name, what: `Released the payment, EFT sent${n}`, tone: "default" });
    }
    if (a.status === "settled") {
      events.push({ when: a.settledAt, who: "Bank", what: `Settled: the supplier received the money${n}`, tone: "good" });
    }
    if (a.status === "failed" && a.failure) {
      events.push({ when: a.failedAt, who: "Bank", what: `Failed: ${a.failure.message}${n}`, tone: "bad" });
    }
    if (a.status === "on_hold") {
      events.push({ when: null, who: "System", what: `Put on hold: ${a.holdReason ?? ""}`, tone: "warn" });
    }
    if (a.status === "cancelled") {
      events.push({ when: null, who: "AP", what: `Cancelled: ${a.cancelReason ?? ""}`, tone: "default" });
    }
  }
  for (const f of flags) {
    const level = f.urgency.charAt(0).toUpperCase() + f.urgency.slice(1);
    events.push({ when: f.createdAt, who: "System", what: `${level} flag raised: ${f.message}`, tone: f.urgency === "low" ? "warn" : "bad" });
    if (f.clearedAt) {
      events.push({
        when: f.clearedAt,
        who: f.clearedAutomatically ? "System" : (f.clearedBy?.name ?? "—"),
        what: `Cleared the ${f.urgency} flag${f.clearedAutomatically ? " automatically" : ""}${f.clearNote ? `: ${f.clearNote}` : ""}`,
        tone: "good",
      });
    }
  }
  return events;
}

const DOT = { default: "bg-slate-300", good: "bg-emerald-500", bad: "bg-red-500", warn: "bg-amber-500" };

function AuditTrail({
  invoice,
  attempts,
  flags,
}: {
  invoice: InvoiceRecord;
  attempts: PaymentRecord[];
  flags: PaymentFlag[];
}) {
  return (
    <ol className="relative space-y-4 border-l border-slate-200 pl-5">
      {auditEvents(invoice, attempts, flags).map((e, i) => (
        <li key={i} className="relative text-sm">
          <span className={`absolute -left-[1.6rem] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-white ${DOT[e.tone]}`} />
          <p className="text-slate-900">
            <span className="font-medium">{e.who}</span> · {e.what}
          </p>
          <p className="text-xs text-slate-500">{e.when ? formatDate(e.when) : "Date not in sample data"}</p>
        </li>
      ))}
    </ol>
  );
}
