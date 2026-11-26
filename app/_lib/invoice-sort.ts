import { InvoiceSort } from "@/contracts/audit-view";
import type { QueueSort } from "@/server/dashboard/list-query";

// The sort menu on invoice lists (Invoices, Audit trail). A plain module, not a "use client" file,
// so server pages read the real values (docs/rules/frontend.md, BUG-Youssef-06). The ordering itself
// runs in the database (features/audit/list.ts), so it covers every page of results, not just one.

export const SORT_OPTIONS: { value: InvoiceSort; label: string }[] = [
  { value: "newest", label: "Newest to oldest" },
  { value: "oldest", label: "Oldest to newest" },
  { value: "vendor_az", label: "Vendor A to Z" },
  { value: "vendor_za", label: "Vendor Z to A" },
];

export const DEFAULT_SORT: InvoiceSort = "newest";

/** A `?sort=` value from the URL, or the default when it is missing or unknown. */
export function parseSort(value: string | undefined): InvoiceSort {
  const parsed = InvoiceSort.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_SORT;
}

export const sortLabel = (sort: InvoiceSort) => SORT_OPTIONS.find((o) => o.value === sort)!.label;

/**
 * The menu on a work queue (Checks, Duplicates, Payments overview): the page's own order first, as
 * the default ("Most urgent first"), then the same four sorts. `dateWord` says what "newest" means
 * there when it isn't the invoice date (the Payments overview sorts by pay date).
 */
export function queueSortOptions(defaultLabel: string, dateWord?: string): { value: QueueSort; label: string }[] {
  return [{ value: "default", label: defaultLabel }, ...SORT_OPTIONS.map((o) => (dateWord && (o.value === "newest" || o.value === "oldest") ? { ...o, label: `${o.label} (${dateWord})` } : o))];
}
