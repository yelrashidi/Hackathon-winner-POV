import Link from "next/link";

export default function PaymentNotFound() {
  return (
    <div className="mx-auto mt-10 max-w-lg rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
      <h1 className="text-lg font-semibold text-slate-900">We couldn&apos;t find that payment</h1>
      <p className="mt-2 text-sm text-slate-500">The invoice ID in the address doesn&apos;t match any payment.</p>
      <Link
        href="/payments"
        className="mt-6 inline-flex rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
      >
        Go to overview
      </Link>
    </div>
  );
}
