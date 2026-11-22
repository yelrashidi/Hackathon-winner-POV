// Shown while a page loads the signed-in person and their data.
export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading">
      <div className="space-y-2">
        <div className="h-7 w-56 animate-pulse rounded bg-slate-200/70" />
        <div className="h-4 w-96 max-w-full animate-pulse rounded bg-slate-200/50" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-xl bg-white ring-1 ring-slate-200" />
        ))}
      </div>
      <div className="h-80 animate-pulse rounded-xl bg-white ring-1 ring-slate-200" />
    </div>
  );
}
