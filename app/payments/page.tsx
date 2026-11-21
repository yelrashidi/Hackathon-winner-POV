import { getPayments } from "./_lib/data";

// Step 1 placeholder: shows the raw data so it can be checked. Step 3 replaces it with the table.
export default async function PaymentsPage() {
  const { payments, awaitingPayment } = await getPayments();

  return (
    <main className="p-8 font-mono text-sm">
      <p className="mb-4 font-sans font-semibold text-amber-700">Sample data — not real payments</p>
      <p className="mb-4">
        {payments.length} payments · {awaitingPayment.length} awaiting payment
      </p>
      <pre className="whitespace-pre-wrap">{JSON.stringify({ payments, awaitingPayment }, null, 2)}</pre>
    </main>
  );
}
