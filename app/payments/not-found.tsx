import Link from "next/link";

export default function PaymentNotFound() {
  return (
    <div className="mx-auto mt-10 max-w-lg rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
      <h1 className="font-(family-name:--brim-font-display) text-xl font-extrabold text-(--brim-heading)">We couldn&apos;t find that payment</h1>
      <p className="mt-2 text-sm text-slate-500">The invoice ID in the address doesn&apos;t match any payment.</p>
      <Link
        href="/payments"
        className="mt-6 inline-flex rounded-lg bg-(--brim-accent) px-4 py-2 text-sm font-semibold text-(--brim-on-accent) hover:bg-(--brim-accent-hover) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--brim-link) focus-visible:ring-offset-2"
      >
        Go to overview
      </Link>
    </div>
  );
}
