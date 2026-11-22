/**
 * Duplicate-check thresholds, all in one place so every number can be defended in the Q&A.
 * Measured on the history (brim_ap_dataset invoices.csv, Jan–Oct 2026).
 */
export const DUPLICATE_CONFIG = {
  /**
   * DUPLICATE_SUSPECTED: same vendor + same amount, different number, invoice dates at most this
   * many days apart. Fixed monthly fees repeat the same amount ~30 days apart under a new number
   * (20+ vendors do it in the history), so the window must stay well under a month.
   */
  suspectedWindowDays: 7,
  /**
   * Number variants: the shorter number must keep at least this many characters, so "1" vs "1-A"
   * is not a match, and the longer may add at most `variantMaxExtraChars` ("000903" → "000903-A").
   */
  variantMinChars: 3,
  variantMaxExtraChars: 2,
  /**
   * ALREADY_PAID_BY_CARD: the card charge may be posted this many days before the invoice date
   * (paid at order time, billed later) or after it (paid on receipt of the bill).
   */
  cardDaysBefore: 45,
  cardDaysAfter: 45,
  /**
   * Merchant descriptor → vendor: core-name trigram similarity at or above this, used only when
   * the descriptor is not a word-prefix of the vendor's name (descriptors are cut at ~22 chars).
   */
  merchantNameSimilarity: 0.6,
  /**
   * Card sources that are AP's own payment rail (a single-use virtual card that PAYS an invoice).
   * Those charges are the payment of an invoice already on record, not a second payment.
   */
  apPaymentCardSources: ["ap_virtual_card"] as readonly string[],
  /** Statuses that are no longer a live bill: never compared against. */
  ignoredStatuses: ["voided", "rejected"] as readonly string[],
} as const;
