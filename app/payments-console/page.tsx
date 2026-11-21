import { Suspense } from "react";
import Link from "next/link";
import { FailureCode } from "@/contracts/payment";
import { listPayments } from "@/server/features/payments";
import { getCurrentUser } from "@/server/session/current-user";
import { ActionForm, inputClass } from "../payments/_components/ActionForm";
import { resetDemo, settleAction } from "../payments/actions";

// Demo controls only: the simulated bank's answer for released payments, and a reset.
// Every real payment button lives on the dashboard (/payments). Who is acting is the dashboard's
// "Viewing as" person.

export default function Page() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6 font-sans text-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Simulated bank</h1>
        <Link href="/payments" className="text-sm font-medium text-sky-800 hover:underline">
          ← Back to the payments dashboard
        </Link>
      </div>
      <p className="text-sm text-slate-600">
        No real money moves. After a payment is released on the dashboard, choose what the bank answers: settled, or one of
        the failure reasons.
      </p>
      <Suspense fallback={<p>Loading…</p>}>
        <Bank />
      </Suspense>
    </main>
  );
}

const label = (code: string) => code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, " ");

async function Bank() {
  const user = await getCurrentUser();
  const view = await listPayments(user?.id ?? null);
  const released = view.payments.filter((r) => r.current.status === "released");

  return (
    <>
      <p className="text-sm">
        Acting as <span className="font-medium">{user ? user.fullName : "nobody (view only)"}</span>. Change it with
        &quot;Viewing as&quot; on the dashboard.
      </p>
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold">Released, waiting for the bank ({released.length})</h2>
        {released.length === 0 && <p className="text-sm text-slate-500">Nothing released right now.</p>}
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
      </section>
      <form action={resetDemo}>
        <button className="rounded-md bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50">
          Reset demo data
        </button>
      </form>
    </>
  );
}
