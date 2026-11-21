import type { Flag } from "@/contracts/flag";
import { VALIDATION_CONFIG } from "../config";
import { makeFlag } from "../flag";
import { daysBetween } from "../lib/dates";
import type { Rule } from "./types";

/**
 * Odd dates. Compared with the RECEIVED date, not the clock, so the result does not depend on
 * when the check runs (a batch validated next month gives the same flags).
 */
export const datesRule: Rule = (input, _ctx, d) => {
  const flags: Flag[] = [];
  const inv = input.invoiceDate;
  if (!inv) return flags;
  const received = input.receivedDate;

  const age = daysBetween(inv, received);
  if (age < 0) {
    flags.push(
      makeFlag("DATE_IN_FUTURE", `Invoice dated ${inv}, ${-age} day${age === -1 ? "" : "s"} after it was received (${received})`, {
        field: "invoiceDate",
        actual: inv,
        expected: `on or before ${received}`,
      }),
    );
  } else if (age > VALIDATION_CONFIG.staleDays) {
    flags.push(
      makeFlag("DATE_TOO_OLD", `Invoice dated ${inv} was received ${received}, ${age} days later (limit ${VALIDATION_CONFIG.staleDays}) — check it was not already paid or resubmitted`, {
        field: "invoiceDate",
        actual: inv,
        ageDays: age,
        expected: `within ${VALIDATION_CONFIG.staleDays} days of receipt`,
      }),
    );
  }

  if (input.dueDate && !d.isCredit) {
    const dueIn = daysBetween(inv, input.dueDate);
    if (dueIn < 0) {
      flags.push(
        makeFlag("DUE_BEFORE_INVOICE", `Due ${input.dueDate} is before the invoice date ${inv}`, {
          field: "dueDate",
          actual: input.dueDate,
          expected: `on or after ${inv}`,
        }),
      );
    } else if (d.vendor?.paymentTermsDays != null && Math.abs(dueIn - d.vendor.paymentTermsDays) > VALIDATION_CONFIG.termsToleranceDays) {
      const terms = d.vendor.paymentTermsDays;
      flags.push(
        makeFlag(
          "TERMS_MISMATCH",
          `Due ${input.dueDate} is ${dueIn} day${dueIn === 1 ? "" : "s"} after the invoice date; ${d.vendor.legalName}'s terms on file are ${terms === 0 ? "due on receipt" : `Net ${terms}`}`,
          { field: "dueDate", actual: dueIn, expected: terms, source: `vendor master ${d.vendor.id}` },
        ),
      );
    }
  }
  return flags;
};
