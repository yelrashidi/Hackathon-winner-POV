// Shown while a payment's details load. Its own boundary because the page reads the invoice id
// from the URL: navigating from one invoice to another still shows this instantly.
export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading payment">
      <div className="h-4 w-28 animate-pulse rounded bg-slate-200/70" />
      <div className="h-28 animate-pulse rounded-xl bg-white ring-1 ring-slate-200" />
      <div className="h-20 animate-pulse rounded-xl bg-slate-100" />
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="h-64 animate-pulse rounded-xl bg-white ring-1 ring-slate-200" />
        <div className="h-64 animate-pulse rounded-xl bg-white ring-1 ring-slate-200" />
      </div>
    </div>
  );
}
