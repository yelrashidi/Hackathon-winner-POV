import type { Flag } from "@/contracts/flag";
import { VALIDATION_CONFIG } from "../config";
import { makeFlag } from "../flag";
import type { Rule } from "./types";

/**
 * Runs first. Says what is missing; every later rule skips what it cannot check, so a missing
 * field gives one clear flag instead of a cascade of nonsense ones.
 */

const FIELD_LABELS: Record<string, string> = {
  "vendor.nameRaw": "Vendor name",
  invoiceNumber: "Invoice number",
  invoiceDate: "Invoice date",
  dueDate: "Due date",
  currency: "Currency",
  totalCents: "Total",
  subtotalCents: "Subtotal",
  lines: "Line items",
  taxes: "Taxes",
  poNumber: "PO number",
};

export const completenessRule: Rule = (input, _ctx, d) => {
  const flags: Flag[] = [];

  // Impossible calendar dates were set aside by the engine; say so once, with the value as read.
  for (const bad of d.invalidDates) {
    const label = bad.field === "receivedDate" ? "Received date" : FIELD_LABELS[bad.field];
    const effect = bad.replacedWith ? `using ${bad.replacedWith} instead for the date checks` : "date checks skipped until it is corrected";
    flags.push(
      makeFlag("INVALID_DATE", `${label} "${bad.value}" is not a real calendar date — ${effect}; correct it from the document`, {
        field: bad.field,
        actual: bad.value,
        expected: "a real date (YYYY-MM-DD)",
      }),
    );
  }
  const invalid = new Set<string>(d.invalidDates.map((x) => x.field));

  const required: [field: string, present: boolean][] = [
    ["vendor.nameRaw", input.vendor.nameRaw !== null],
    ["invoiceNumber", input.invoiceNumber !== null],
    ["invoiceDate", input.invoiceDate !== null],
    ["currency", input.currency !== null],
    ["totalCents", input.totalCents !== null],
    ["lines", input.lines.length > 0],
  ];
  for (const [field, present] of required) {
    if (present || invalid.has(field)) continue;
    flags.push(
      makeFlag("MISSING_REQUIRED_FIELD", `${FIELD_LABELS[field]} is missing — enter it from the document before submitting`, {
        field,
      }),
    );
  }

  for (const [field, confidence] of Object.entries(input.confidence)) {
    if (confidence >= VALIDATION_CONFIG.lowConfidence) continue;
    const label = FIELD_LABELS[field] ?? field;
    flags.push(
      makeFlag(
        "LOW_CONFIDENCE_FIELD",
        `${label} was read with ${Math.round(confidence * 100)}% confidence (threshold ${Math.round(VALIDATION_CONFIG.lowConfidence * 100)}%) — check it against the document`,
        { field, actual: confidence, expected: VALIDATION_CONFIG.lowConfidence },
      ),
    );
  }

  const currency = input.currency?.trim().toUpperCase();
  if (currency && !VALIDATION_CONFIG.supportedCurrencies.includes(currency)) {
    flags.push(
      makeFlag(
        "CURRENCY_UNSUPPORTED",
        `Currency ${currency} is not supported (${VALIDATION_CONFIG.supportedCurrencies.join(", ")} only)`,
        { field: "currency", actual: currency, expected: VALIDATION_CONFIG.supportedCurrencies },
      ),
    );
  }

  return flags;
};
