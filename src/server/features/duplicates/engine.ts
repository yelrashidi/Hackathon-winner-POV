import type { Flag, FlagSeverity } from "@/contracts/flag";
import { daysBetween, formatMoney, isRealDate, sameInvoiceNumber, VALIDATION_CONFIG } from "@/server/features/validation";
import { DUPLICATE_CODES, type DuplicateCode } from "./codes";
import { DUPLICATE_CONFIG } from "./config";
import type { CardTxnRef, DuplicateContext, InvoiceOnRecord } from "./context";
import { matchMerchant } from "./merchant";
import { compareNumbers, type NumberRelation } from "./numbers";

/**
 * Feature 5 — is this bill already on record, or already paid by card? Pure: no I/O, no clock.
 *
 * Invoice vs invoice — only against the copy that came FIRST (earlier received date, then
 * created time, then id), so a pair raises one flag, on the second copy, which is the one a
 * person would void. One flag per earlier invoice, the strongest that applies:
 *   DUPLICATE_DOCUMENT        same file sha256                                   (any vendor)
 *   DUPLICATE_INVOICE         same vendor, same number once reformatted
 *   DUPLICATE_NUMBER_VARIANT  same vendor, number + short prefix/suffix, AND same amount or date
 *   DUPLICATE_SUSPECTED       same vendor, other number, same amount, dates ≤ 7 days apart
 * Invoice vs card — ALREADY_PAID_BY_CARD: a charge at this vendor (merchant name → vendor), same
 * amount, posted near the invoice date. AP's own virtual-card payments are skipped: they pay an
 * invoice that is already on record, so the invoice comparison covers them.
 *
 * Duplicate AND probable split: both facts, for the person deciding. Validation's split check
 * (SPLIT_INVOICE_SUSPECTED) leaves same / near-same numbers out of its sums, so for those pairs it
 * stays silent. Here, next to the duplicate flag, SPLIT_IF_NOT_DUPLICATE says what the pair would
 * be if both bills are real: same vendor, within validation's split window, each at or under an
 * approval limit, together over it. Confirming the duplicate resolves it with the duplicate flag.
 *
 * Credit notes are compared only with credit notes. Voided / rejected invoices are ignored.
 * Nothing is decided here: every flag goes to a person on the duplicates dashboard.
 */

export interface DuplicateResult {
  invoiceId: string;
  /** block first, then warn; within a severity, closest match first. */
  flags: Flag[];
  blocking: boolean;
}

const SEVERITY_ORDER: Record<FlagSeverity, number> = { block: 0, warn: 1, info: 2 };

/** Order of arrival: received date (else invoice date), then created time, then id. */
function arrivalKey(i: InvoiceOnRecord): string {
  return [i.receivedDate ?? i.invoiceDate ?? "", i.createdAt ?? "", i.invoiceId].join("|");
}

const isLive = (i: InvoiceOnRecord) => !DUPLICATE_CONFIG.ignoredStatuses.includes(i.status.trim().toLowerCase());

function sameAmount(a: InvoiceOnRecord, b: InvoiceOnRecord): boolean {
  if (a.totalCents !== null && b.totalCents !== null && a.currency && a.currency === b.currency) return a.totalCents === b.totalCents && a.totalCents !== 0;
  return a.totalCadCents !== null && a.totalCadCents === b.totalCadCents && a.totalCadCents !== 0;
}

function daysApart(a: string | null, b: string | null): number | null {
  if (!a || !b || !isRealDate(a) || !isRealDate(b)) return null;
  return Math.abs(daysBetween(a, b));
}

const money = (i: InvoiceOnRecord) => (i.totalCents !== null ? formatMoney(i.totalCents, i.currency) : "no total");
const describe = (i: InvoiceOnRecord) =>
  `${i.invoiceId} (no. ${i.invoiceNumber ?? "—"}, dated ${i.invoiceDate ?? "—"}, ${money(i)}, ${i.status.toLowerCase()})`;

function flag(code: DuplicateCode, message: string, evidence: Record<string, unknown>, related: { invoiceId?: string; cardTxnId?: string }): Flag {
  const f: Flag = { code, severity: DUPLICATE_CODES[code].severity, message, evidence: { rule: "duplicates", ...evidence }, status: "open" };
  if (related.invoiceId) f.relatedInvoiceId = related.invoiceId;
  if (related.cardTxnId) f.relatedCardTxnId = related.cardTxnId;
  return f;
}

/** The strongest invoice-vs-invoice match between `inv` and an earlier `other`, or null. */
function compareInvoices(inv: InvoiceOnRecord, other: InvoiceOnRecord): Flag | null {
  const amount = sameAmount(inv, other);
  const date = inv.invoiceDate !== null && inv.invoiceDate === other.invoiceDate;
  const days = daysApart(inv.invoiceDate, other.invoiceDate);
  const relation: NumberRelation = compareNumbers(inv.invoiceNumber, other.invoiceNumber);
  const evidence = {
    // `field` gives the flag its identity across re-runs (flagKey = code|field|line): one flag
    // per earlier invoice, so "not a duplicate of X" survives a re-run and a new match Y is new.
    field: `related:${other.invoiceId}`,
    numberRelation: relation,
    sameAmount: amount,
    sameDate: date,
    daysApart: days,
    invoiceNumber: inv.invoiceNumber,
    relatedInvoiceNumber: other.invoiceNumber,
    relatedInvoiceDate: other.invoiceDate,
    relatedTotalCents: other.totalCents,
    relatedCurrency: other.currency,
    relatedStatus: other.status,
  };
  const related = { invoiceId: other.invoiceId };
  const here = `This one: no. ${inv.invoiceNumber ?? "—"}, dated ${inv.invoiceDate ?? "—"}, ${money(inv)}.`;

  if (inv.documentSha256 && inv.documentSha256 === other.documentSha256) {
    return flag("DUPLICATE_DOCUMENT", `The same file was already received as invoice ${describe(other)}.`, { ...evidence, sha256: inv.documentSha256 }, related);
  }
  if (!inv.vendorId || inv.vendorId !== other.vendorId) return null;

  if (relation === "same") {
    const differs = [!amount && "amount", !date && "date"].filter(Boolean).join(" and ");
    return flag(
      "DUPLICATE_INVOICE",
      `Invoice number ${inv.invoiceNumber} from this vendor is already on record as ${describe(other)}. ${here}${differs ? ` The ${differs} differ${differs.includes(" and ") ? "" : "s"}.` : ""}`,
      evidence,
      related,
    );
  }
  if (relation === "variant" && (amount || date)) {
    return flag(
      "DUPLICATE_NUMBER_VARIANT",
      `Invoice number ${inv.invoiceNumber} looks like a re-issue of ${other.invoiceNumber} — ${describe(other)} — with the same ${[amount && "amount", date && "date"].filter(Boolean).join(" and ")}. ${here}`,
      evidence,
      related,
    );
  }
  if (relation === "different" && amount && days !== null && days <= DUPLICATE_CONFIG.suspectedWindowDays) {
    return flag(
      "DUPLICATE_SUSPECTED",
      `Same vendor and same amount ${money(inv)} ${days === 0 ? "on the same day" : `${days} day${days === 1 ? "" : "s"} apart`} as ${describe(other)}, under a different number (${inv.invoiceNumber ?? "—"}). Check it is not the same bill re-issued.`,
      evidence,
      related,
    );
  }
  return null;
}

function cardMatches(inv: InvoiceOnRecord, ctx: DuplicateContext): Flag[] {
  if (!inv.vendorId || inv.isCreditNote || inv.totalCents === null || inv.totalCents <= 0) return [];
  const anchor = inv.invoiceDate ?? inv.receivedDate;
  if (!anchor || !isRealDate(anchor)) return [];

  const vendorByDescriptor = new Map<string, ReturnType<typeof matchMerchant>>();
  const vendorOf = (t: CardTxnRef) => {
    if (t.vendorId) return { vendorId: t.vendorId, method: "on_record" as const, similarity: 1 };
    if (!vendorByDescriptor.has(t.merchantDescriptor)) vendorByDescriptor.set(t.merchantDescriptor, matchMerchant(t.merchantDescriptor, ctx.vendors));
    return vendorByDescriptor.get(t.merchantDescriptor) ?? null;
  };

  const out: Flag[] = [];
  for (const t of ctx.cardTransactions) {
    if (DUPLICATE_CONFIG.apPaymentCardSources.includes(t.source)) continue;
    const amountMatch = (t.currency === inv.currency && t.amountCents === inv.totalCents) || (inv.totalCadCents !== null && t.amountCadCents === inv.totalCadCents);
    if (!amountMatch || !isRealDate(t.postedDate)) continue;
    const offset = daysBetween(anchor, t.postedDate); // negative = charged before the invoice date
    if (offset < -DUPLICATE_CONFIG.cardDaysBefore || offset > DUPLICATE_CONFIG.cardDaysAfter) continue;
    const m = vendorOf(t);
    if (!m || m.vendorId !== inv.vendorId) continue;

    const when = offset === 0 ? "on the invoice date" : `${Math.abs(offset)} day${Math.abs(offset) === 1 ? "" : "s"} ${offset < 0 ? "before" : "after"} the invoice date`;
    out.push(
      flag(
        "ALREADY_PAID_BY_CARD",
        `Card charge ${t.id} at "${t.merchantDescriptor}" for ${formatMoney(t.amountCents, t.currency)} on ${t.postedDate} (${when}${t.cardholderId ? `, cardholder ${t.cardholderId}` : ""}) matches this invoice's ${money(inv)}: it may already be paid by card.`,
        {
          field: `card:${t.id}`,
          cardTxnId: t.id,
          merchantDescriptor: t.merchantDescriptor,
          merchantMatch: m.method,
          merchantSimilarity: m.similarity,
          postedDate: t.postedDate,
          daysFromInvoiceDate: offset,
          cardAmountCents: t.amountCents,
          cardCurrency: t.currency,
          cardholderId: t.cardholderId,
          cardSource: t.source,
        },
        { cardTxnId: t.id },
      ),
    );
  }
  return out;
}

/**
 * The split fact for a duplicate pair that validation's split check does not see, or null.
 * Same thresholds (approval policies) and window (VALIDATION_CONFIG.splitWindowDays) as validation.
 */
function splitIfNotDuplicate(inv: InvoiceOnRecord, other: InvoiceOnRecord, thresholds: readonly number[]): Flag | null {
  if (!thresholds.length || !inv.vendorId || inv.vendorId !== other.vendorId || inv.isCreditNote) return null;
  // Only pairs validation leaves out; every other pair is already in its own split check.
  if (!inv.invoiceNumber || !other.invoiceNumber || !sameInvoiceNumber(inv.invoiceNumber, other.invoiceNumber)) return null;
  const a = inv.totalCadCents;
  const b = other.totalCadCents;
  if (a === null || b === null || a <= 0 || b <= 0) return null;
  const days = daysApart(inv.invoiceDate, other.invoiceDate);
  if (days === null || days > VALIDATION_CONFIG.splitWindowDays) return null;

  const combined = a + b;
  const limit = [...thresholds].sort((x, y) => y - x).find((t) => a <= t && b <= t && combined > t);
  if (limit === undefined) return null;
  const within = days === 0 ? "on the same day" : `within ${days} day${days === 1 ? "" : "s"}`;
  return flag(
    "SPLIT_IF_NOT_DUPLICATE",
    `If this is NOT a duplicate of ${other.invoiceId}, the two bills together are ${formatMoney(combined)} CAD ${within}: over the ${formatMoney(limit)} approval limit that each stays under (${formatMoney(a)} + ${formatMoney(b)}). Treat it as a possible split and approve on the combined total.`,
    {
      field: `split:${other.invoiceId}`,
      combinedCadCents: combined,
      thresholdCadCents: limit,
      invoiceCadCents: a,
      relatedCadCents: b,
      daysApart: days,
      windowDays: VALIDATION_CONFIG.splitWindowDays,
      source: "approval policies",
    },
    { invoiceId: other.invoiceId },
  );
}

export function checkDuplicates(inv: InvoiceOnRecord, ctx: DuplicateContext): DuplicateResult {
  const mine = arrivalKey(inv);
  const flags: { f: Flag; days: number }[] = [];
  for (const other of ctx.invoices) {
    if (other.invoiceId === inv.invoiceId || !isLive(other)) continue;
    if (other.isCreditNote !== inv.isCreditNote) continue;
    if (arrivalKey(other) >= mine) continue; // only the copy that came first is "the original"
    const f = compareInvoices(inv, other);
    if (!f) continue;
    const days = daysApart(inv.invoiceDate, other.invoiceDate) ?? 9999;
    flags.push({ f, days });
    const split = splitIfNotDuplicate(inv, other, ctx.approvalThresholdsCadCents ?? []);
    if (split) flags.push({ f: split, days });
  }
  for (const f of cardMatches(inv, ctx)) flags.push({ f, days: Math.abs(Number((f.evidence as { daysFromInvoiceDate: number }).daysFromInvoiceDate)) });

  const sorted = flags.sort((a, b) => SEVERITY_ORDER[a.f.severity] - SEVERITY_ORDER[b.f.severity] || a.days - b.days).map((x) => x.f);
  return { invoiceId: inv.invoiceId, flags: sorted, blocking: sorted.some((f) => f.status === "open" && f.severity === "block") };
}
