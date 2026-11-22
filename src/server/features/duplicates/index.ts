/**
 * Feature 5 — duplicates. Public surface; other features import from here only.
 *
 *   checkDuplicates(invoice, ctx) → DuplicateResult     (pure; flags with the related invoice / card charge)
 *   compareNumbers / canonicalNumber                      ("ST-4471" = "ST4471", "000903" ~ "000903-A")
 *   matchMerchant(descriptor, vendors)                    (card merchant → vendor, by name)
 *   DUPLICATE_CODES                                       (every code, severity and why)
 *
 * Nothing here decides a duplicate. Every flag waits for a person on the duplicates dashboard.
 */
export { checkDuplicates, type DuplicateResult } from "./engine";
export { compareNumbers, canonicalNumber, digitCore, type NumberRelation } from "./numbers";
export { matchMerchant, type MerchantMatch } from "./merchant";
export { DUPLICATE_CODES, ALL_DUPLICATE_CODES, VOIDING_CODES, type DuplicateCode } from "./codes";
export { DUPLICATE_CONFIG } from "./config";
export type * from "./context";

// Database (db/): the analysis-pass step, the two human decisions, the dashboard's read model.
export { checkDuplicatesWithin, checkDuplicatesAndPersist } from "./db/run";
export { confirmDuplicate, dismissDuplicate, DuplicateActionError } from "./db/decide";
export { listDuplicateReviews, SPLIT_CODES, type DuplicateReview, type InvoiceSide, type CardSide, type SplitFact } from "./db/queue";
export { loadDuplicateContext, loadFullDuplicateContext, loadInvoiceRecord } from "./db/load-context";
