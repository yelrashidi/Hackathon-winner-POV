import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Executor } from "@/server/db/client";
import { approvalPolicies, contracts, fxRates, invoiceLines, invoices, purchaseOrders, taxCodes, vendorBankAccounts, vendors } from "@/server/db/schema";
import type { BankAccountStatus, PriorInvoice, ValidationContext, VendorRef } from "../context";
import { HARBORLINE_OFFICES } from "../dataset/load-context";
import { mulRate } from "../lib/money";

/**
 * Builds the ValidationContext from Postgres — the same object the CSV loader
 * (dataset/load-context.ts) builds, so validateInvoice() stays pure and unchanged.
 *
 * With `vendorIds`, the per-vendor lists (bank accounts, POs, contracts, prior invoices) only hold
 * those vendors' rows; the vendor list itself is always complete, because vendor matching has to
 * search every vendor. Pass the candidates from matchVendor() for a fast single-invoice run.
 * `excludeInvoiceId` keeps an invoice from being compared with itself on a re-run.
 */
export async function loadDbContext(
  db: Executor,
  opts: { today: string; vendorIds?: readonly string[]; excludeInvoiceId?: string },
): Promise<ValidationContext> {
  const only = opts.vendorIds ? [...opts.vendorIds] : null;
  const byVendor = <T>(col: T) => (only ? inArray(col as never, only.length ? only : ["-"]) : undefined);

  const [vendorRows, counts, bankRows, poRows, contractRows, invoiceRows, taxRows, fxRows, policyRows] = await Promise.all([
    db.select().from(vendors),
    db
      .select({ vendorId: invoices.vendorId, n: sql<number>`count(*)::int` })
      .from(invoices)
      .where(ne(invoices.status, "Voided"))
      .groupBy(invoices.vendorId),
    db.select().from(vendorBankAccounts).where(byVendor(vendorBankAccounts.vendorId)),
    db.select().from(purchaseOrders).where(byVendor(purchaseOrders.vendorId)),
    db.select().from(contracts).where(byVendor(contracts.vendorId)),
    db
      .select()
      .from(invoices)
      .where(and(byVendor(invoices.vendorId), opts.excludeInvoiceId ? ne(invoices.id, opts.excludeInvoiceId) : undefined)),
    db.select().from(taxCodes),
    db.select().from(fxRates),
    db.select().from(approvalPolicies).where(eq(approvalPolicies.active, true)),
  ]);

  const countByVendor = new Map(counts.map((c) => [c.vendorId, c.n]));
  const vendorRefs: VendorRef[] = vendorRows.map((v) => ({
    id: v.id,
    legalName: v.legalName,
    category: v.category,
    province: v.provinceOrState,
    country: v.country,
    gstHstNumber: v.gstHstNumber,
    qstNumber: v.qstNumber,
    paymentTermsDays: v.paymentTermsDays,
    requiresPo: v.requiresPo,
    status: v.status,
    contactEmail: v.apContactEmail,
    onboardedAt: v.onboardedAt,
    invoiceCount: countByVendor.get(v.id) ?? 0,
  }));

  // Tax codes that appeared on each prior invoice's lines.
  const invoiceIds = invoiceRows.map((i) => i.id);
  const lineCodes = invoiceIds.length
    ? await db
        .select({ invoiceId: invoiceLines.invoiceId, gst: invoiceLines.gstHstCode, pst: invoiceLines.pstQstCode })
        .from(invoiceLines)
        .where(only ? inArray(invoiceLines.invoiceId, invoiceIds) : undefined)
    : [];
  const codesBy = new Map<string, Set<string>>();
  for (const l of lineCodes) {
    const set = codesBy.get(l.invoiceId) ?? new Set<string>();
    if (l.gst) set.add(l.gst);
    if (l.pst) set.add(l.pst);
    codesBy.set(l.invoiceId, set);
  }

  const priorInvoices: PriorInvoice[] = invoiceRows
    .filter((i) => i.vendorId && i.invoiceNumber && i.invoiceDate && i.currency && i.totalCents !== null)
    .map((i) => {
      const total = i.totalCents!;
      const subtotal = i.subtotalCents ?? total;
      const totalCad = i.totalCadCents ?? total;
      return {
        invoiceId: i.id,
        vendorId: i.vendorId!,
        invoiceNumber: i.invoiceNumber!,
        invoiceDate: i.invoiceDate!,
        currency: i.currency!,
        subtotalCents: subtotal,
        totalCents: total,
        // Integer-cents conversion at the stored rate (docs/rules/money-and-tax.md), as the CSV loader does.
        subtotalCadCents: i.currency === "CAD" ? subtotal : mulRate(subtotal, i.fxRate ?? "1"),
        totalCadCents: totalCad,
        poId: i.poId,
        contractId: i.contractId,
        // "Voided" lower-cases to an ignored status, like the CSV's "rejected".
        status: i.status,
        isCreditNote: i.isCreditNote,
        taxCodes: [...(codesBy.get(i.id) ?? [])],
      };
    });

  const thresholds = approvalThresholdsFromPolicyRows(policyRows);

  return {
    today: opts.today,
    vendors: vendorRefs,
    bankAccounts: bankRows.map((b) => ({
      vendorId: b.vendorId,
      version: b.version,
      status: b.status as BankAccountStatus,
      institution: b.institution,
      transit: b.transit,
      account: b.account,
      last4: b.last4,
      changedAt: b.changedAt,
      channel: b.channel,
    })),
    purchaseOrders: poRows.map((p) => ({
      id: p.id,
      vendorId: p.vendorId,
      departmentId: p.departmentId,
      totalCents: p.totalAmountCents,
      currency: p.currency,
      status: p.status,
      issueDate: p.issueDate,
    })),
    contracts: contractRows.map((c) => ({
      id: c.id,
      vendorId: c.vendorId,
      description: c.description,
      billingType: c.billingType,
      monthlyFeeCents: c.monthlyFeeCents,
      currency: c.currency,
      hourlyRateCapCents: c.hourlyRateCapCents,
      fuelSurchargeCapPct: c.fuelSurchargeCapPct,
      notToExceedMonthlyCents: c.notToExceedMonthlyCents,
      startDate: c.startDate,
      endDate: c.endDate,
      autoRenew: c.autoRenew,
      status: c.status,
    })),
    priorInvoices,
    taxCodes: taxRows.map((t) => ({
      code: t.code,
      description: t.description,
      rate: t.rate,
      appliesTo: t.appliesTo,
      recoverable: t.recoverable ? "yes" : "no",
      glAccount: t.glAccount,
    })),
    fxRates: fxRows.map((f) => ({ date: f.date, usdToCad: f.usdToCad })).sort((a, b) => a.date.localeCompare(b.date)),
    offices: HARBORLINE_OFFICES,
    approvalThresholdsCadCents: thresholds,
  };
}

/**
 * Amount-tier boundaries (CAD cents, ascending) from the active approval policies: every
 * `amount_over` / `amount_up_to` condition of a chain rule. Shared with duplicates (5), which
 * reports a probable split for pairs this rule set leaves out of its own split check.
 */
export function approvalThresholdsFromPolicyRows(policyRows: readonly { ruleType: string; conditions: unknown; steps: unknown }[]): number[] {
  const thresholds = new Set<number>();
  for (const p of policyRows) {
    const c = p.conditions as { kind?: string; cadCents?: number };
    const s = p.steps as { type?: string };
    if (p.ruleType === "approval" && s.type === "chain" && (c.kind === "amount_over" || c.kind === "amount_up_to") && typeof c.cadCents === "number") thresholds.add(c.cadCents);
  }
  return [...thresholds].sort((a, b) => a - b);
}
