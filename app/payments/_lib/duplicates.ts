import "server-only";

// The one place the dashboard reads duplicate flags: the duplicates service on Postgres
// (src/server/features/duplicates). If the database is not configured or not reachable, the
// page says so instead of crashing the whole dashboard (payments still runs in memory).

import { connection } from "next/server";
import { listDuplicateReviews, type DuplicateReview } from "@/server/features/duplicates";

export type { DuplicateReview } from "@/server/features/duplicates";

export type DuplicateQueue = { ok: true; reviews: DuplicateReview[] } | { ok: false; reason: string };

export async function getDuplicateQueue(): Promise<DuplicateQueue> {
  // Database reads happen at request time, never while Next.js prerenders the page shell
  // (the embedded demo database reads the clock, which prerendering forbids).
  await connection();
  try {
    return { ok: true, reviews: await listDuplicateReviews() };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason };
  }
}

/** For the sidebar badge; null when the database is unavailable. */
export async function openDuplicateCount(): Promise<number | null> {
  const q = await getDuplicateQueue();
  return q.ok ? new Set(q.reviews.map((r) => r.invoice.invoiceId)).size : null;
}
