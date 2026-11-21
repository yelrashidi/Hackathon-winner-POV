import type { Flag } from "@/contracts/flag";
import { VALIDATION_CONFIG } from "../config";
import type { PriorInvoice } from "../context";
import { makeFlag } from "../flag";
import { daysBetween } from "../lib/dates";
import { formatMoney } from "../lib/money";
import type { Rule } from "./types";

/**
 * Invoices split to stay under an approval limit: the same vendor, within a few days, each at or
 * under a policy threshold, together over it. Thresholds come from the approval policies (amount
 * tiers), never constants here. Credit notes and duplicates (same or near-same number) never count.
 *
 * Contract with approvals (src/contracts/approvals.ts): code SPLIT_INVOICE_SUSPECTED and
 * `evidence.combinedCadCents` (integer CAD cents). Approvals routes on that combined total.
 */
export const splitRule: Rule = (input, ctx, d) => {
  const flags: Flag[] = [];
  if (!d.vendor || d.isCredit || !input.invoiceDate || d.totalCadCents === null || d.totalCadCents <= 0) return flags;
  const me = d.totalCadCents;
  const date = input.invoiceDate;
  const window = VALIDATION_CONFIG.splitWindowDays;

  const near = d.vendorPrior.filter(
    (p) => !p.isCreditNote && p.totalCadCents > 0 && Math.abs(daysBetween(p.invoiceDate, date)) <= window,
  );
  if (near.length === 0) return flags;

  // The highest threshold that this invoice is under and the group crosses.
  const thresholds = [...ctx.approvalThresholdsCadCents].sort((a, b) => b - a);
  for (const t of thresholds) {
    if (me > t) continue;
    const group: PriorInvoice[] = near.filter((p) => p.totalCadCents <= t);
    const combined = me + group.reduce((s, p) => s + p.totalCadCents, 0);
    if (group.length === 0 || combined <= t) continue;
    group.sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate));
    flags.push(
      makeFlag(
        "SPLIT_INVOICE_SUSPECTED",
        `With ${group.map((p) => `${p.invoiceNumber} (${p.invoiceDate}, ${formatMoney(p.totalCadCents)})`).join(", ")}, ${d.vendor.legalName} billed a combined ${formatMoney(combined)} CAD within ${window} days — each invoice is at or under the ${formatMoney(t)} approval limit, together they exceed it; approvals routes on the combined total`,
        {
          field: "totalCents",
          combinedCadCents: combined,
          thresholdCadCents: t,
          invoiceCadCents: me,
          windowDays: window,
          relatedInvoiceIds: group.map((p) => p.invoiceId),
          source: "approval policies",
        },
        { relatedInvoiceId: group[0]!.invoiceId },
      ),
    );
    break;
  }
  return flags;
};
