/**
 * Feature 4 — validation. Public surface; other features import from here only.
 *
 *   validateInvoice(input, ctx) → ValidationResult   (pure; flags + vendorId + totalCadCents)
 *   hasBlocking(flags)                                (the submit guard)
 *   matchVendor(input, vendors)                       (shared vendor resolution)
 *   FLAG_CODES                                        (every code, severity and why)
 *
 * Database (db/): validateWithin / validateAndPersist (validated against Postgres), persistFlags (keeps human resolutions by flagKey), overrideFlag / resolveFlag, loadDbContext.
 */
export { validateInvoice, hasBlocking, RULES, type ValidationResult } from "./engine";
export { matchVendor, type VendorMatch, type VendorCandidate, type VendorMatchMethod } from "./vendor-match";
export { FLAG_CODES, ALL_FLAG_CODES, type FlagCode, type CodeInfo, type RuleGroup } from "./codes";
export { flagKey } from "./flag";
export { VALIDATION_CONFIG } from "./config";
export type * from "./context";
export { validateAndPersist, validateWithin } from "./db/run";
export { persistFlags, syncFlags, type PersistSummary, type FlagSource } from "./db/persist";
export { overrideFlag, resolveFlag, FlagActionError } from "./db/override";
export { loadDbContext } from "./db/load-context";
