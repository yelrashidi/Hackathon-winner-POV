import { z } from "zod";

/**
 * One flag shape for every stage (docs/rules/contracts.md). Validation (4) and duplicates (5)
 * emit it, approvals (6) and payments (7) read it, the UI renders it without knowing who raised it.
 * Mirrors the `invoice_flags` table in docs/architecture/data-model.md.
 */
export const FlagSeverity = z.enum(["block", "warn", "info"]);
export type FlagSeverity = z.infer<typeof FlagSeverity>;

export const FlagStatus = z.enum(["open", "resolved", "overridden"]);
export type FlagStatus = z.infer<typeof FlagStatus>;

export const Flag = z.object({
  /** SCREAMING_SNAKE, stable once a UI or test uses it, e.g. TAX_PROVINCE_MISMATCH. */
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  severity: FlagSeverity,
  /** Says what is wrong with the numbers in it: "Unit price $250.00 exceeds contract cap $230.00 (contract C-014)". */
  message: z.string().min(1),
  evidence: z.record(z.string(), z.unknown()).default({}),
  relatedInvoiceId: z.string().optional(),
  relatedCardTxnId: z.string().optional(),
  /** Only `open` flags affect routing; resolved/overridden ones are history. */
  status: FlagStatus.default("open"),
});
export type Flag = z.infer<typeof Flag>;
