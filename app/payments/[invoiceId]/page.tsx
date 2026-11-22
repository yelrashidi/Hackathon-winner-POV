import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { getCurrentUser } from "@/server/session/current-user";
import { cancelAction, rejectBankAction, requestBankAction, verifyBankAction } from "../actions";
import { ActionForm, inputClass } from "../_components/ActionForm";
import { actionFor, PaymentAction, type ActionLabel } from "../_components/ActionsSpot";
import { describeAttempt } from "../_components/PaymentsTable";
import { FlagList } from "../_components/Flags";
import { StatusBadge } from "../_components/StatusBadge";
import { canAct, dashboardRole } from "../_lib/access";
import { canRetry, getInvoice, getPaymentRow } from "../_lib/data";
import { formatDate, formatMoney, formatMoneyWithCode } from "../_lib/format";
import { eligibleReleasers, getPaymentAudit, getSupplierBank, type AuditEvent as PaymentAuditEvent } from "@/server/features/payments";
import type { InvoiceRecord, PaymentRecord } from "@/contracts/payment";

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
  const releasers = row ? (await eligibleReleasers(id)).map((p) => p.name) : [];
  const bank = await getSupplierBank(user?.id ?? null, invoice.vendorId);
  const audit = await getPaymentAudit(user?.id ?? null, id);
  const names = new Map([invoice.requestedBy, ...invoice.approvedBy, ...(row?.attempts ?? []).flatMap((a) => [a.preparedBy, a.releasedBy, a.cancelledBy])]
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .map((p) => [p.userId, p.name]));

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

      <StatusPanel invoice={invoice} current={current} action={action} retryOk={row ? canRetry(row) : true}>
        {row && current?.status === "scheduled" && (
          <ReleasePanel
            blockers={row.releaseCheck.reasons}
            isReleaser={role === "finance_manager" || role === "controller"}
            releasers={releasers}
            showAction={action === "Release"}
            invoiceId={invoice.invoiceId}
            paymentId={current.paymentId}
          />
        )}
      </StatusPanel>

      {current && canAct(role) && (current.status === "scheduled" || current.status === "on_hold") && (
        <Card title="Cancel this payment" note="Only before release. The invoice goes back to approved, and this attempt stays in the history.">
          <ActionForm action={cancelAction} label="Cancel payment" hidden={{ paymentId: current.paymentId }} tone="danger">
            <input name="reason" aria-label="Reason" placeholder="Reason (required)" className={`w-72 ${inputClass}`} />
          </ActionForm>
        </Card>
      )}

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

      <BankCard bank={bank} vendorId={invoice.vendorId} canAct={canAct(role)} needsNewDetails={current?.failure?.retryRule === "FIX_BANK_DETAILS"} />

      <Card
        title="Audit trail"
        note="Every payment action, from the payments audit log (kept in memory until the shared audit log, feature 8, exists)."
      >
        <AuditTrail invoice={invoice} events={audit} names={names} />
      </Card>
    </>
  );
}

/** What's going on with this payment right now, and what happens next. */
function StatusPanel({
  invoice,
  current,
  action,
  retryOk,
  children,
}: {
  invoice: InvoiceRecord;
  current: PaymentRecord | null;
  action: ActionLabel | null;
  /** False while a fraud hold the Controller hasn't cleared blocks the retry. */
  retryOk: boolean;
  children?: ReactNode;
}) {
  if (!current) {
    return (
      <Panel tone="slate" title="Approved, waiting to be scheduled">
        <p>
          Approved by {invoice.approvedBy.map((p) => p.name).join(", ")}. An AP Clerk or Controller schedules the
          payment next.
        </p>
        {action && <PaymentAction label={action} invoiceId={invoice.invoiceId} />}
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
          {action && retryOk && <PaymentAction label={action} invoiceId={invoice.invoiceId} />}
          {reason?.retryRule === "ESCALATE" && !retryOk && <p className="font-medium">No retry until the Controller clears the fraud hold.</p>}
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
          <p>
            {current.cancelReason}
            {current.cancelledBy ? ` (${current.cancelledBy.name})` : ""}
          </p>
          {action && <PaymentAction label={action} invoiceId={invoice.invoiceId} />}
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
  invoiceId,
  paymentId,
}: {
  blockers: { code: string; message: string }[];
  isReleaser: boolean;
  releasers: string[];
  showAction: boolean;
  invoiceId: string;
  paymentId: string;
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
      {showAction && <PaymentAction label="Release" invoiceId={invoiceId} paymentId={paymentId} />}
    </Panel>
  ) : (
    <Panel tone="rose" title="You can't release this payment">
      <ul className="list-disc space-y-0.5 pl-5">
        {blockers.map((b) => (
          <li key={b.code + b.message}>{b.message}</li>
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

type TrailEvent = { when: string | null; who: string; what: string; tone: "default" | "good" | "bad" | "warn" };

const ACTION_TEXT: Record<string, { what: string; tone: TrailEvent["tone"] }> = {
  "invoice.schedule": { what: "Invoice moved to payment scheduled", tone: "default" },
  "invoice.paymentSettled": { what: "Invoice marked paid", tone: "good" },
  "invoice.paymentFailed": { what: "Invoice back to approved: payment failed", tone: "bad" },
  "invoice.paymentCancelled": { what: "Invoice back to approved: payment cancelled", tone: "default" },
  "payment.scheduled": { what: "Scheduled the payment", tone: "default" },
  "payment.retried": { what: "Scheduled a retry (new attempt)", tone: "default" },
  "payment.released": { what: "Released the payment, EFT sent", tone: "default" },
  "payment.settled": { what: "Bank: settled", tone: "good" },
  "payment.failed": { what: "Bank: failed", tone: "bad" },
  "payment.cancelled": { what: "Cancelled the payment", tone: "default" },
  "payment.on_hold": { what: "Payment put on hold", tone: "warn" },
  "payment.hold_released": { what: "Hold released", tone: "good" },
  "payment_flag.created": { what: "Flag raised", tone: "bad" },
  "payment_flag.cleared": { what: "Cleared a flag", tone: "good" },
  "payment_flag.cleared_automatically": { what: "Flag cleared automatically", tone: "good" },
  "bank_account.closed": { what: "Bank account marked unpayable", tone: "bad" },
  "bank_account.change_requested": { what: "Entered new bank details", tone: "warn" },
  "bank_account.verified": { what: "Verified the new bank details", tone: "good" },
  "bank_account.rejected": { what: "Rejected the bank change", tone: "default" },
};

function trailEvents(invoice: InvoiceRecord, audit: PaymentAuditEvent[], names: Map<string, string>): TrailEvent[] {
  const events: TrailEvent[] = [
    { when: null, who: invoice.requestedBy.name, what: "Requested the invoice", tone: "default" },
    ...invoice.approvedBy.map((p) => ({ when: null, who: p.name, what: "Approved the invoice", tone: "default" as const })),
  ];
  for (const e of audit) {
    const known = ACTION_TEXT[e.action] ?? { what: e.action, tone: "default" as const };
    const code = (e.after as { code?: string; urgency?: string } | null)?.code ?? (e.after as { urgency?: string } | null)?.urgency;
    events.push({
      when: e.occurredAt,
      who: names.get(e.actorId) ?? e.actorId,
      what: `${known.what}${code ? ` (${code.toLowerCase().replace(/_/g, " ")})` : ""}${e.reason ? `: ${e.reason}` : ""}`,
      tone: known.tone,
    });
  }
  return events;
}

const DOT = { default: "bg-slate-300", good: "bg-emerald-500", bad: "bg-red-500", warn: "bg-amber-500" };

function AuditTrail({ invoice, events, names }: { invoice: InvoiceRecord; events: PaymentAuditEvent[]; names: Map<string, string> }) {
  return (
    <ol className="relative space-y-4 border-l border-slate-200 pl-5">
      {trailEvents(invoice, events, names).map((e, i) => (
        <li key={i} className="relative text-sm">
          <span className={`absolute -left-[1.6rem] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-white ${DOT[e.tone]}`} />
          <p className="text-slate-900">
            <span className="font-medium">{e.who}</span> · {e.what}
          </p>
          <p className="text-xs text-slate-500">{e.when ? `${formatDate(e.when)} ${e.when.slice(11, 16)} UTC` : "Before payments (approval history)"}</p>
        </li>
      ))}
    </ol>
  );
}

type BankVersion = Awaited<ReturnType<typeof getSupplierBank>>[number];

/** The supplier's bank account versions (last 4 digits only), and the controlled change: enter, then a second person verifies. */
function BankCard({ bank, vendorId, canAct, needsNewDetails }: { bank: BankVersion[]; vendorId: string; canAct: boolean; needsNewDetails: boolean }) {
  const pending = bank.find((b) => b.status === "pending");
  const hasVerified = bank.some((b) => b.status === "verified");
  return (
    <Card title="Supplier bank details" note="Only the last 4 digits are ever shown. A change is entered by one person and verified by another.">
      <ul className="space-y-1 text-sm">
        {bank.map((b) => (
          <li key={b.version} className="text-slate-700">
            v{b.version} ••{b.last4} {b.currency} · <span className="font-medium">{b.status}</span>
            {b.changedAt ? ` · changed ${formatDate(b.changedAt)}` : ""}
            {b.channel ? ` by ${b.channel.replace(/_/g, " ")}` : ""}
            {b.requestedBy ? ` · entered by ${b.requestedBy.name}` : ""}
            {b.verifiedBy ? ` · verified by ${b.verifiedBy.name}` : ""}
          </li>
        ))}
        {bank.length === 0 && <li className="text-slate-500">No bank account on file.</li>}
      </ul>
      {canAct && pending && (
        <div className="mt-4 flex flex-wrap gap-4">
          <ActionForm action={verifyBankAction} label={`Verify ••${pending.last4}`} hidden={{ vendorId }} />
          <ActionForm action={rejectBankAction} label={`Reject ••${pending.last4}`} hidden={{ vendorId }} tone="danger">
            <input name="reason" aria-label="Reason" placeholder="Reason" className={`w-48 ${inputClass}`} />
          </ActionForm>
        </div>
      )}
      {canAct && !pending && (needsNewDetails || !hasVerified) && (
        <div className="mt-4">
          <ActionForm action={requestBankAction} label="Save new bank details" hidden={{ vendorId }}>
            <input name="institution" aria-label="Institution" placeholder="Institution (3)" className={`w-28 ${inputClass}`} />
            <input name="transit" aria-label="Transit" placeholder="Transit (5)" className={`w-28 ${inputClass}`} />
            <input name="account" aria-label="Account" placeholder="Account (7–12)" className={`w-36 ${inputClass}`} />
          </ActionForm>
        </div>
      )}
    </Card>
  );
}
