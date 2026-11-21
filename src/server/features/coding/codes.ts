import type { Flag, FlagSeverity } from "@/contracts/flag";

/**
 * Every flag coding raises: default severity and one line on why it matters. Same shape as
 * validation's codes, so the UI renders them the same way. Stable once a UI or test uses them.
 */
export const CODING_FLAG_CODES = {
  CODING_NO_LINES: { severity: "warn", why: "No line items were extracted, so nothing can be coded until lines are entered." },
  CODING_NO_SUGGESTION: { severity: "warn", why: "Nothing in the history points at an account for this line; a person must code it." },
  CODING_DEPARTMENT_UNCERTAIN: { severity: "warn", why: "The requester is unknown and the vendor bills several departments; a person must pick the requesting one." },
  CODING_CAPITALIZE_REVIEW: { severity: "warn", why: "The unit price is over the account's expense limit per unit; the item may need to be capitalised as an asset." },
  CODING_PREPAID_REVIEW: { severity: "info", why: "The line covers a period beyond this month (annual, 12 months); expensing it all now overstates this month." },
  CODING_TAX_UNALLOCATED: { severity: "warn", why: "A tax amount has no known tax code (or nothing to spread over), so the journal cannot place it." },
  CODING_JOURNAL_UNBALANCED: { severity: "warn", why: "Lines plus taxes do not add up to the invoice total, so the journal entry would not balance." },
  CODING_UNUSUAL_ACCOUNT: { severity: "warn", why: "A person chose an account this vendor has never been coded to: a mistake, or spend being hidden in the wrong bucket." },
  CODING_DEPARTMENT_DIFFERS: { severity: "info", why: "A line is charged to a department other than the requesting one, whose manager does not approve it." },
  CODING_NOT_CONFIRMED: { severity: "block", why: "Every line must be accepted or changed by a person before the invoice goes to approval." },
} as const satisfies Record<string, { severity: FlagSeverity; why: string }>;

export type CodingFlagCode = keyof typeof CODING_FLAG_CODES;

export interface CodingEvidence {
  /** Which part the flag is about: "lines", "department", "taxes", "journal". */
  field: string;
  lineNo?: number;
  [key: string]: unknown;
}

export function codingFlag(code: CodingFlagCode, message: string, evidence: CodingEvidence): Flag {
  return { code, severity: CODING_FLAG_CODES[code].severity, message, evidence: { rule: "coding", ...evidence }, status: "open" };
}
