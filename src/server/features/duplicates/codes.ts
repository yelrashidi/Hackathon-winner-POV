import type { FlagSeverity } from "@/contracts/flag";

/**
 * Every flag code duplicates can raise. Stable once a UI or test uses them (CLAUDE.md).
 *
 * No duplicate verdict is automatic. A flag only says "this looks like the same bill"; a person
 * decides on the duplicates dashboard: confirm (the invoice is voided / closed) or "not a
 * duplicate" (the flag is overridden with a note). `block` stops submit until that decision.
 */
export interface DuplicateCodeInfo {
  severity: FlagSeverity;
  why: string;
}

export const DUPLICATE_CODES = {
  DUPLICATE_DOCUMENT: {
    severity: "block",
    why: "The very same file (byte for byte) was already received as another invoice.",
  },
  DUPLICATE_INVOICE: {
    severity: "block",
    why: "Same vendor and the same invoice number once spaces, dashes and leading zeros are ignored (ST-4471 = ST4471, 000604 = 604).",
  },
  DUPLICATE_NUMBER_VARIANT: {
    severity: "block",
    why: "Same vendor, an invoice number that differs only by a prefix or suffix (000903 vs 000903-A, FA-001655 vs 1655-A), and the same amount or date.",
  },
  DUPLICATE_SUSPECTED: {
    severity: "warn",
    why: "Same vendor and the same amount a few days apart under a different number. Could be a re-issued bill — or two real orders.",
  },
  SPLIT_IF_NOT_DUPLICATE: {
    severity: "warn",
    why: "Shown with a duplicate flag: if the two bills are both real (not a duplicate), together they exceed an approval limit that each stays under, so a possible split. Validation leaves same-number pairs out of its own split check, so this is where the reviewer sees it.",
  },
  ALREADY_PAID_BY_CARD: {
    severity: "block",
    why: "A Brim card transaction at this vendor for the same amount around the invoice date: the bill may already have been paid by card.",
  },
} as const satisfies Record<string, DuplicateCodeInfo>;

export type DuplicateCode = keyof typeof DUPLICATE_CODES;
export const ALL_DUPLICATE_CODES = Object.keys(DUPLICATE_CODES) as DuplicateCode[];

/** Codes a person resolves by confirming "it is a duplicate" → the invoice is voided. */
export const VOIDING_CODES: readonly DuplicateCode[] = ["DUPLICATE_DOCUMENT", "DUPLICATE_INVOICE", "DUPLICATE_NUMBER_VARIANT", "DUPLICATE_SUSPECTED"];
