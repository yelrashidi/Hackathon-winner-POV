/**
 * Every tunable number in coding, in one place so it can be defended in the Q&A. Accounts, tax
 * rates, departments and the capitalisation limit are NOT here: they come from data.
 */
export const CODING_CONFIG = {
  /** "12 of the last 12": how many of a vendor's most recent lines count as evidence. */
  window: 12,
  /** high confidence: at least this share of the evidence agrees … */
  highShare: 0.9,
  /** … and at least this many lines of evidence. */
  highMinCount: 3,
  /** medium confidence below high, down to this share. Below it: low. */
  mediumShare: 0.6,
  /** Two descriptions are "the same kind of line" at or above this weighted-token similarity (0..1). */
  similarLine: 0.5,
  /** "The same product": another vendor's line at or above this similarity (two needed, agreeing). */
  nearIdentical: 0.8,
  /** A word votes for an account only if at least this share of the lines with it agree. */
  wordPurity: 0.8,
  /** A word vote is medium confidence only if its word appears on at least this many lines. */
  wordMinLines: 5,
  /** A changed account never seen on a vendor with at least this many coded lines is unusual. */
  unusualMinHistory: 3,
  /** Max length of a person's note on a coding change. */
  maxNoteLength: 500,
} as const;

export type CodingConfig = typeof CODING_CONFIG;
