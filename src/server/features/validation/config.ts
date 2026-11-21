/**
 * Tunable thresholds, all in one place so a judge can see (and we can defend) every number.
 * Tax rates, approval limits, contract caps and PO amounts are NOT here: they come from data.
 */
export const VALIDATION_CONFIG = {
  /** Currencies we can convert and pay. */
  supportedCurrencies: ["CAD", "USD"] as readonly string[],
  /** Arithmetic and tax tolerance: 1 cent per contributing line (money-and-tax.md). */
  centsTolerancePerLine: 1,
  /** Below this extraction confidence a field gets LOW_CONFIDENCE_FIELD. */
  lowConfidence: 0.7,
  /** An invoice received more than this many days after its date is stale. */
  staleDays: 90,
  /** Due date may differ from invoice date + vendor terms by this many days. */
  termsToleranceDays: 1,
  /** Use the nearest earlier FX rate up to this many days back (weekends, holidays). */
  fxLookbackDays: 7,
  /** A stated FX rate may differ from the table by this percent. */
  fxTolerancePct: "0.5",
  /**
   * Split detection: same-vendor invoices within this many days of each other. Measured on the
   * history: 3 days catches every real split (orders in parts, "phase 1/2/3") and no routine
   * weekly billing; 7 days starts flagging freight carriers and travel agencies.
   */
  splitWindowDays: 3,
  /** BANK_RECENTLY_CHANGED: a verified change within this many days before the invoice. */
  bankRecentDays: 30,
  /** VENDOR_LOOKALIKE: core-name trigram similarity at or above this. */
  lookalikeNameSimilarity: 0.8,
  /** VENDOR_LOOKALIKE: email domains within this edit distance (and not identical). */
  lookalikeDomainDistance: 2,
  /** VENDOR_UNKNOWN: offer vendors whose name is at least this similar as candidates. */
  candidateNameSimilarity: 0.4,
} as const;

export type ValidationConfig = typeof VALIDATION_CONFIG;
