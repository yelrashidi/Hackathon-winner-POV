import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ValidationInput, type ValidationInputDraft } from "@/contracts/validation";
import type { PriorInvoice, ValidationContext } from "../context";
import { derive } from "../derive";
import { isRealDate } from "../lib/dates";
import { validateInvoice, type ValidationResult } from "../engine";
import { normalizeInvoiceNumber } from "../lib/text";

/**
 * Validates a batch the way the system sees it: every invoice in the batch is already stored
 * (status InReview) when the analysis pass runs, so each one is checked against the history AND
 * the rest of the batch (needed for splits, monthly caps and fixed fees billed twice).
 */

export interface IncomingFixture {
  source: string;
  emailId: string;
  input: ValidationInputDraft;
  expectedCodes: string[] | null;
  why: string;
}

export const INCOMING_FIXTURES_DIR = path.resolve(process.cwd(), "fixtures/validation/incoming");

export function loadIncomingFixtures(dir = INCOMING_FIXTURES_DIR): { file: string; fixture: IncomingFixture }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => ({ file, fixture: JSON.parse(readFileSync(path.join(dir, file), "utf8")) as IncomingFixture }));
}

/** What a stored, not-yet-approved invoice looks like to the rules. */
export function toPriorInvoice(raw: ValidationInputDraft, base: ValidationContext): PriorInvoice | null {
  const input = ValidationInput.parse(raw);
  if (!isRealDate(input.receivedDate) || (input.invoiceDate && !isRealDate(input.invoiceDate))) return null;
  const d = derive(input, base);
  if (!d.vendor || !input.invoiceNumber || !input.invoiceDate || !d.currency || input.totalCents === null || d.subtotalCents === null) return null;
  const po = input.poNumber ? base.purchaseOrders.find((p) => normalizeInvoiceNumber(p.id) === normalizeInvoiceNumber(input.poNumber!)) : undefined;
  return {
    invoiceId: input.invoiceId,
    vendorId: d.vendor.id,
    invoiceNumber: input.invoiceNumber,
    invoiceDate: input.invoiceDate,
    currency: d.currency,
    subtotalCents: d.subtotalCents,
    totalCents: input.totalCents,
    subtotalCadCents: d.subtotalCadCents ?? d.subtotalCents,
    totalCadCents: d.totalCadCents ?? input.totalCents,
    poId: po?.id ?? null,
    contractId: null,
    status: "in_review",
    isCreditNote: d.isCredit,
    taxCodes: input.taxes.map((t) => t.code).filter((c): c is string => c !== null),
  };
}

export function validateBatch(inputs: readonly ValidationInputDraft[], base: ValidationContext): ValidationResult[] {
  const batchPriors = inputs.map((i) => toPriorInvoice(i, base)).filter((p): p is PriorInvoice => p !== null);
  const ctx: ValidationContext = { ...base, priorInvoices: [...base.priorInvoices, ...batchPriors] };
  return inputs.map((i) => validateInvoice(i, ctx));
}
