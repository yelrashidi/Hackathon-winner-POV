"use client";

import Form from "next/form";
import Link from "next/link";

type Option = { value: string; label: string };

/**
 * Search, status and vendor filters, and the sort. Changing a select submits the form, Enter submits
 * the search; the page filters and sorts on the server (src/server/dashboard/list-query.ts).
 */
export function FilterBar({
  statuses,
  vendors,
  status,
  vendor,
  search,
  sort,
  sortOptions,
  defaultSort,
}: {
  statuses: Option[];
  vendors: Option[];
  status: string;
  vendor: string;
  search: string;
  sort: string;
  sortOptions: Option[];
  /** The sort the page uses when none is picked; it is left out of the URL. */
  defaultSort: string;
}) {
  const filtered = status !== "" || vendor !== "" || search !== "" || sort !== defaultSort;

  return (
    <Form action="/payments" className="flex flex-wrap items-center gap-3" role="search">
      <label className="flex min-w-56 flex-1 items-center gap-2 text-sm text-slate-600">
        Search
        <input
          type="search"
          name="q"
          defaultValue={search}
          placeholder="Vendor, invoice number or id"
          className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-(--brim-link) focus:outline-none focus:ring-2 focus:ring-(--brim-link)/20"
        />
      </label>
      <Select name="status" label="Status" options={statuses} value={status} />
      <Select name="vendor" label="Vendor" options={vendors} value={vendor} />
      <label className="flex items-center gap-2 text-sm text-slate-600">
        Sort by
        <select
          name="sort"
          defaultValue={sort}
          onChange={(e) => e.currentTarget.form?.requestSubmit()}
          className="rounded-lg border border-slate-200 bg-white py-1.5 pl-2.5 pr-8 text-sm text-slate-900 shadow-sm focus:border-(--brim-link) focus:outline-none focus:ring-2 focus:ring-(--brim-link)/20"
        >
          {sortOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {filtered && (
        <Link href="/payments" className="text-sm font-medium text-(--brim-link) hover:underline">
          Clear filters
        </Link>
      )}
      <noscript>
        <button type="submit" className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white">
          Apply
        </button>
      </noscript>
    </Form>
  );
}

function Select({ name, label, options, value }: { name: string; label: string; options: Option[]; value: string }) {
  return (
    <label className="flex items-center gap-2 text-sm text-slate-600">
      {label}
      <select
        name={name}
        defaultValue={value}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="rounded-lg border border-slate-200 bg-white py-1.5 pl-2.5 pr-8 text-sm text-slate-900 shadow-sm focus:border-(--brim-link) focus:outline-none focus:ring-2 focus:ring-(--brim-link)/20"
      >
        <option value="">All</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
