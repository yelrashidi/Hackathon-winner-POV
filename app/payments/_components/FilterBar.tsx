"use client";

import Form from "next/form";
import Link from "next/link";

type Option = { value: string; label: string };

/** Status and vendor filters. Changing a select submits the form; the page filters on the server. */
export function FilterBar({
  statuses,
  vendors,
  status,
  vendor,
}: {
  statuses: Option[];
  vendors: Option[];
  status: string;
  vendor: string;
}) {
  const filtered = status !== "" || vendor !== "";

  return (
    <Form action="/payments" className="flex flex-wrap items-center gap-3">
      <Select name="status" label="Status" options={statuses} value={status} />
      <Select name="vendor" label="Vendor" options={vendors} value={vendor} />
      {filtered && (
        <Link href="/payments" className="text-sm font-medium text-indigo-600 hover:text-indigo-700">
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
        className="rounded-lg border border-slate-200 bg-white py-1.5 pl-2.5 pr-8 text-sm text-slate-900 shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
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
