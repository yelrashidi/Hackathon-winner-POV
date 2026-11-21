/**
 * Feature 3 — smart coding. Public surface; other features import from here only.
 *
 *   suggestCoding(invoice, vendorId, ctx) → CodingResult   (pure; per-line account + department, journal, flags)
 *   codeLine / acceptConfident                             (a person accepts or changes; server-side checks)
 *   codingSubmitFlags(lines)                               (submit guard: every line confirmed)
 *   buildJournal(invoice, lines, ctx)                      (re-preview the entry after changes)
 *   CodingIndex                                            (the history; add() confirmed lines to learn)
 *
 * The vendor id comes from validation's matchVendor, so coding, validation and duplicates agree.
 */
export { suggestCoding } from "./suggest";
export {
  codeLine,
  acceptConfident,
  codingSubmitFlags,
  lineDepartments,
  toCodedLines,
  CODING_ROLES,
  type CodingActor,
  type CodingDenied,
  type CodingDeniedCode,
  type InvoiceCodingRef,
} from "./decide";
export { buildJournal, allocate } from "./journal";
export { reviewLine, perUnitLimitCents } from "./review";
export { CodingIndex, type IndexedLine } from "./history";
export { CODING_FLAG_CODES, type CodingFlagCode } from "./codes";
export { CODING_CONFIG } from "./config";
export { tokenize } from "./text";
export type * from "./context";
