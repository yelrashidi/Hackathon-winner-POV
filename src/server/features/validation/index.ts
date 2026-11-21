/**
 * Feature 4 — validation. Public surface; other features import from here only.
 *
 *   validateInvoice(input, ctx) → ValidationResult   (pure; flags + vendorId + totalCadCents)
 *   hasBlocking(flags)                                (the submit guard)
 *   matchVendor(input, vendors)                       (shared vendor resolution)
 *   FLAG_CODES                                        (every code, severity and why)
 *
 * Still to come once the foundation lands: a DB loader for ValidationContext, persisting flags
 * to invoice_flags (keeping resolutions by flagKey), and the override endpoint.
 */
export { validateInvoice, hasBlocking, RULES, type ValidationResult } from "./engine";
export { matchVendor, type VendorMatch, type VendorCandidate, type VendorMatchMethod } from "./vendor-match";
export { FLAG_CODES, ALL_FLAG_CODES, type FlagCode, type CodeInfo, type RuleGroup } from "./codes";
export { flagKey } from "./flag";
export { VALIDATION_CONFIG } from "./config";
export type * from "./context";
