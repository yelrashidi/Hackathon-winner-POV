import { InvoiceSort } from "@/contracts/audit-view";

/**
 * Search + sort for the work queues (Checks, Duplicates, Payments overview). Those lists are the open
 * work, loaded whole by their feature's service, so they are narrowed here in memory. The full invoice
 * history is a different case: Invoices and the Audit trail page through the database
 * (features/audit/list.ts, same sort names).
 *
 *   "default"    the page's own order, unchanged (Checks: most urgent first)
 *   newest / oldest       by the row's date (nulls last), then id
 *   vendor_az / vendor_za alphabetical, case- and accent-insensitive (nulls last), then newest, then id
 *
 * Search matches every text the row offers (vendor, invoice number, id, ...), case-insensitive, and
 * also with punctuation and spaces ignored, so "ST4471" finds "ST-4471".
 */

export type QueueSort = "default" | InvoiceSort;

/** A `?sort=` value, or "default" when it is missing or unknown. */
export function parseQueueSort(value: string | undefined): QueueSort {
  const parsed = InvoiceSort.safeParse(value);
  return parsed.success ? parsed.data : "default";
}

export interface ListKey {
  /** Every text a search may match: vendor, invoice number, id, the related invoice's, a card merchant... */
  text: (string | null | undefined)[];
  /** What the vendor sorts use. */
  vendor: string | null | undefined;
  /** YYYY-MM-DD; what newest / oldest use. */
  date: string | null | undefined;
  /** Last tiebreak, so the order never depends on how the rows arrived. */
  id: string;
}

const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const collator = new Intl.Collator("en-CA", { sensitivity: "base" });

/** Rows whose texts contain the search (as typed, or with punctuation and spaces ignored). */
export function matchesSearch(key: ListKey, search: string | undefined): boolean {
  const q = search?.trim().toLowerCase();
  if (!q) return true;
  const qs = squash(q);
  return key.text.some((t) => {
    if (!t) return false;
    const low = t.toLowerCase();
    return low.includes(q) || (qs.length > 0 && squash(low).includes(qs));
  });
}

function compare(a: ListKey, b: ListKey, sort: InvoiceSort): number {
  const byId = a.id.localeCompare(b.id);
  const byDate = (dir: 1 | -1) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1; // nulls last, both directions
    if (!b.date) return -1;
    return dir * a.date.localeCompare(b.date);
  };
  const byVendor = (dir: 1 | -1) => {
    if (!a.vendor && !b.vendor) return 0;
    if (!a.vendor) return 1;
    if (!b.vendor) return -1;
    return dir * collator.compare(a.vendor, b.vendor);
  };
  switch (sort) {
    case "newest":
      return byDate(-1) || -byId;
    case "oldest":
      return byDate(1) || byId;
    case "vendor_az":
      return byVendor(1) || byDate(-1) || -byId;
    case "vendor_za":
      return byVendor(-1) || byDate(-1) || -byId;
  }
}

/** The rows that match `search`, in `sort` order ("default" keeps the order they came in). */
export function searchAndSort<T>(rows: readonly T[], query: { search?: string; sort: QueueSort }, keyOf: (row: T) => ListKey): T[] {
  const keyed = rows.map((row) => ({ row, key: keyOf(row) })).filter((r) => matchesSearch(r.key, query.search));
  if (query.sort !== "default") {
    const sort = query.sort;
    keyed.sort((a, b) => compare(a.key, b.key, sort));
  }
  return keyed.map((r) => r.row);
}
