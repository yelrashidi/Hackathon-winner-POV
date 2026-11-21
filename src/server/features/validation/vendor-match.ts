import type { ValidationInput } from "@/contracts/validation";
import { VALIDATION_CONFIG } from "./config";
import type { VendorRef } from "./context";
import { coreName, emailDomain, lightName, normalizeTaxNumber, trigramSimilarity } from "./lib/text";

/**
 * Matches an extracted invoice to the vendor master. Deterministic, strongest evidence first:
 *   1. GST/HST number (exact, then the 9-digit business-number root), or QST number
 *   2. legal name, lightly normalised ("Ltd." = "Ltd", but "&" ≠ "and" on purpose)
 *   3. the sender's email domain, when exactly one vendor uses it
 * A fuzzy name is never a match, only a candidate shown to the clerk (VENDOR_UNKNOWN).
 * Exported for coding, duplicates and approvals, which need the same vendor id.
 */

export type VendorMatchMethod = "tax_number" | "name" | "email_domain" | "none";

export interface VendorCandidate {
  vendorId: string;
  legalName: string;
  /** 0..1 core-name similarity. */
  similarity: number;
}

export interface VendorMatch {
  vendor: VendorRef | null;
  method: VendorMatchMethod;
  /** Closest other vendors by name, best first (max 3). */
  candidates: VendorCandidate[];
}

type MatchInput = Pick<ValidationInput, "vendor" | "senderEmail">;

/** When several vendors share a key, the most established record wins; a tie is ambiguous. */
function pickOne(list: readonly VendorRef[]): VendorRef | null {
  if (list.length === 0) return null;
  if (list.length === 1) return list[0]!;
  const sorted = [...list].sort((a, b) => b.invoiceCount - a.invoiceCount);
  return sorted[0]!.invoiceCount > sorted[1]!.invoiceCount ? sorted[0]! : null;
}

export function matchVendor(input: MatchInput, vendors: readonly VendorRef[]): VendorMatch {
  const name = input.vendor.nameRaw;
  const candidatesFor = (exclude: string | null): VendorCandidate[] => {
    if (!name) return [];
    const core = coreName(name);
    return vendors
      .filter((v) => v.id !== exclude)
      .map((v) => ({ vendorId: v.id, legalName: v.legalName, similarity: trigramSimilarity(core, coreName(v.legalName)) }))
      .filter((c) => c.similarity >= VALIDATION_CONFIG.candidateNameSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 3);
  };
  const done = (vendor: VendorRef | null, method: VendorMatchMethod): VendorMatch => ({
    vendor,
    method: vendor ? method : "none",
    candidates: candidatesFor(vendor?.id ?? null),
  });

  // 1. Tax registration number.
  const gst = input.vendor.gstHstNumber ? normalizeTaxNumber(input.vendor.gstHstNumber) : null;
  if (gst) {
    const exact = pickOne(vendors.filter((v) => v.gstHstNumber && normalizeTaxNumber(v.gstHstNumber) === gst));
    if (exact) return done(exact, "tax_number");
    const root = gst.slice(0, 9);
    if (/^\d{9}$/.test(root)) {
      const byRoot = pickOne(vendors.filter((v) => v.gstHstNumber && normalizeTaxNumber(v.gstHstNumber).slice(0, 9) === root));
      if (byRoot) return done(byRoot, "tax_number");
    }
  }
  const qst = input.vendor.qstNumber ? normalizeTaxNumber(input.vendor.qstNumber) : null;
  if (qst) {
    const byQst = pickOne(vendors.filter((v) => v.qstNumber && normalizeTaxNumber(v.qstNumber) === qst));
    if (byQst) return done(byQst, "tax_number");
  }

  // 2. Legal name.
  if (name) {
    const light = lightName(name);
    const byName = pickOne(vendors.filter((v) => lightName(v.legalName) === light));
    if (byName) return done(byName, "name");
  }

  // 3. Sender email domain (only when it points at one vendor, or one clearly by name).
  const domain = emailDomain(input.senderEmail);
  if (domain) {
    const sameDomain = vendors.filter((v) => emailDomain(v.contactEmail) === domain);
    if (sameDomain.length === 1) return done(sameDomain[0]!, "email_domain");
    if (sameDomain.length > 1 && name) {
      const core = coreName(name);
      const scored = sameDomain
        .map((v) => ({ v, s: trigramSimilarity(core, coreName(v.legalName)) }))
        .sort((a, b) => b.s - a.s);
      const [top, second] = scored;
      if (top && top.s >= VALIDATION_CONFIG.candidateNameSimilarity && (!second || top.s > second.s)) {
        return done(top.v, "email_domain");
      }
    }
  }

  return done(null, "none");
}
