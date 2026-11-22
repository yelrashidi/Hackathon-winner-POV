import { coreName, trigramSimilarity } from "@/server/features/validation";
import { DUPLICATE_CONFIG } from "./config";
import type { VendorName } from "./context";

/**
 * Card merchant descriptor → vendor, by name. Card networks send a short upper-case descriptor,
 * usually cut at ~22 characters: "VOYAGEUR CORPORATE TRA", "ALPENGLOW EVENTS & CAT".
 *
 *   1. Prefix: the descriptor's core name is the start of exactly one vendor's core name
 *      ("voyageur corporate tra" → "voyageur corporate travel"). Handles the truncation.
 *   2. Otherwise trigram similarity ≥ merchantNameSimilarity, and the best is strictly better
 *      than the runner-up.
 * Ambiguous or weak → null: an unmatched charge is never a duplicate. Same name normalisation as
 * validation's vendor matching (legal suffixes and punctuation ignored, "&" = "and").
 */
export interface MerchantMatch {
  vendorId: string;
  method: "prefix" | "similar";
  similarity: number;
}

/** Shortest descriptor core we trust as a prefix: shorter strings start too many names. */
const MIN_PREFIX_CHARS = 6;

export function matchMerchant(descriptor: string, vendors: readonly VendorName[]): MerchantMatch | null {
  const d = coreName(descriptor);
  if (!d) return null;

  if (d.length >= MIN_PREFIX_CHARS) {
    const byPrefix = vendors.filter((v) => coreName(v.legalName).startsWith(d));
    const ids = new Set(byPrefix.map((v) => v.id));
    if (ids.size === 1) return { vendorId: byPrefix[0]!.id, method: "prefix", similarity: 1 };
    if (ids.size > 1) return null;
  }

  const scored = vendors
    .map((v) => ({ v, s: trigramSimilarity(d, coreName(v.legalName)) }))
    .sort((a, b) => b.s - a.s);
  const [top, second] = scored;
  if (!top || top.s < DUPLICATE_CONFIG.merchantNameSimilarity) return null;
  if (second && second.s === top.s) return null;
  return { vendorId: top.v.id, method: "similar", similarity: Math.round(top.s * 100) / 100 };
}
