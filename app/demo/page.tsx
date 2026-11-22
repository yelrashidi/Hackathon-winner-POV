import type { Metadata } from "next";
import Link from "next/link";
import { FailureCode } from "@/contracts/payment";
import { usingDemoDb } from "@/server/demo/database";
import { paymentsDb } from "@/server/pipeline";
import { getViewer } from "@/server/session/current-user";
import { ActionForm } from "../_components/ActionForm";
import { inputClass } from "../_lib/styles";
import { Card, Notice, PageHeader } from "../_components/ui";
import { resetDemo, sendToApprovalDemo, settleAction } from "../payments/actions";

export const metadata: Metadata = { title: "Demo controls" };

// Demo controls only: the simulated bank's answer for released payments, and a reset. Every real
// payment button lives on the dashboard. Who is acting is the signed-in person.

const label = (code: string) => code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, " ");

export default async function DemoPage() {
  const viewer = await getViewer();
  const view = await paymentsDb.list(viewer?.user.id ?? null);
  const released = view.payments.filter((r) => r.current.status === "released");
  const finance = viewer && ["clerk", "finance", "admin"].includes(viewer.role);

  return (
    <>
      <PageHeader title="Demo controls" description="Not part of the product: the simulated bank and a reset, so the whole flow can be shown end to end. No real money moves." />
      <Card title={`Simulated bank · released, waiting for the bank's answer (${released.length})`} description="After a payment is released, choose what the bank answers: settled, or one of the failure reasons.">
        {!finance && <Notice tone="info">Sign in as an AP Clerk, the Finance Manager or the Admin to answer for the bank.</Notice>}
        {released.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing released right now.</p>
        ) : (
          <ul className="space-y-4">
            {released.map((row) => (
              <li key={row.current.paymentId} className="flex flex-wrap items-start justify-between gap-3 text-sm">
                <div>
                  <Link href={`/payments/${row.invoice.invoiceId}`} className="font-medium hover:underline">
                    {row.invoice.vendorName}
                  </Link>
                  <p className="text-xs text-slate-500">
                    Invoice {row.invoice.vendorInvoiceNumber} · attempt {row.current.attemptNo} · to ••{row.current.bankAccount.last4}
                  </p>
                </div>
                <ActionForm action={settleAction} label="Send bank answer" hidden={{ paymentId: row.current.paymentId }}>
                  <select name="outcome" aria-label="Bank answer" className={inputClass}>
                    <option value="SETTLED">Settled</option>
                    {FailureCode.options.map((c) => (
                      <option key={c} value={c}>
                        Fail: {label(c)}
                      </option>
                    ))}
                  </select>
                </ActionForm>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Shortcut: send a few clean bills to approval" description="Does what an AP Clerk does on Checks for up to 3 bills with no open flags — sets the requester, confirms the coding, submits — as the clerk, every step in the audit trail. Then sign in as a manager to approve.">
        <ActionForm action={sendToApprovalDemo} label="Send 3 clean bills to approval" pendingLabel="Working…" />
      </Card>
      <Card title="Start again" description={usingDemoDb() ? "Rebuilds the in-process demo database from the dataset: 10 months of history, the AP inbox run through intake, every audit row. Takes about 5 seconds." : "The app is on a real database (DATABASE_URL); reset it with npm run db:reset."}>
        {usingDemoDb() && viewer?.role !== "admin" && <p className="text-sm text-slate-500">Only the Admin can reset the demo (sign in as Marcus Webb or Priya Raman).</p>}
        {usingDemoDb() && viewer?.role === "admin" && (
          <form action={resetDemo}>
            <button className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-rose-700 ring-1 ring-inset ring-rose-300 hover:bg-rose-50">Reset demo data</button>
          </form>
        )}
      </Card>
    </>
  );
}
