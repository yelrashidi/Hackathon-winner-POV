import type { JournalPreview } from "@/contracts/coding";
import { FX_GAIN_LOSS_ACCOUNT, JOURNAL_ACCOUNTS } from "./config";

/**
 * Bonus feature — the accounting journal (pure, no database).
 *
 *   BILL entry (when a bill is approved; dated the invoice date)
 *     Dr  each coded line's account + department         line amount
 *     Dr  1160 / 1165 recoverable GST/HST / QST           tax
 *     Dr  goods lines' accounts                           their share of non-recoverable tax (BC PST)
 *       Cr  2100 Accounts Payable                         invoice total
 *   = coding's own journal (buildJournal), the one the clerk saw on Checks, converted to CAD.
 *
 *   PAYMENT entry (when the bank confirms it; dated the paid / settled date)
 *     Dr  2100 Accounts Payable                           what this payment clears, at the BILL's rate
 *       Cr  bank (EFT, cheque) or Brim card payable (card) what left, at the payment's rate
 *       Cr  purchase discounts                            an early-payment discount taken
 *       Dr/Cr 7020 FX gain/loss                           any difference between the two rates
 *
 * Every amount is integer cents in CAD (the books' currency); the original currency amount and the
 * rate stay on each line so the conversion can be traced. Every entry balances by construction;
 * a bill whose own journal does not balance, or has an uncoded line, is EXCLUDED with the reason —
 * never exported half-right.
 */

export type EntryType = "bill" | "payment";

export interface JournalLineOut {
  entryId: string;
  entryDate: string;
  entryType: EntryType;
  invoiceId: string;
  paymentId: string | null;
  vendorId: string | null;
  vendorName: string;
  reference: string;
  glAccount: string;
  accountName: string;
  departmentId: string | null;
  description: string;
  debitCents: number;
  creditCents: number;
  currency: string;
  /** The line's amount in the document's own currency (signed: positive = debit). */
  amountOriginalCents: number;
  fxRate: string;
}

export interface JournalEntryOut {
  entryId: string;
  entryType: EntryType;
  entryDate: string;
  invoiceId: string;
  paymentId: string | null;
  vendorName: string;
  reference: string;
  lines: JournalLineOut[];
  debitCents: number;
  creditCents: number;
}

export interface Excluded {
  entryType: EntryType;
  id: string;
  invoiceId: string;
  vendorName: string;
  reason: string;
}

export type Built = { ok: true; entry: JournalEntryOut } | { ok: false; excluded: Excluded };

// ---------------------------------------------------------------------------------------------
// Money: cents × a decimal rate, exactly (no floating point), rounded half away from zero.
// ---------------------------------------------------------------------------------------------

export function toCad(cents: number, rate: string): number {
  const r = rate.trim();
  if (!/^\d+(\.\d+)?$/.test(r)) throw new Error(`Not a rate: "${rate}"`);
  const [whole = "0", frac = ""] = r.split(".");
  const scale = 10n ** BigInt(frac.length);
  const rateScaled = BigInt(whole) * scale + BigInt(frac || "0");
  const product = BigInt(Math.abs(cents)) * rateScaled;
  const rounded = (product * 2n + scale) / (2n * scale); // half up on the absolute value
  return Number(rounded) * (cents < 0 ? -1 : 1);
}

const isOne = (rate: string) => /^0*1(\.0*)?$/.test(rate.trim());

/** A signed debit amount (positive = debit, negative = credit) → the two non-negative columns. */
const sides = (signedDebitCents: number) => ({ debitCents: Math.max(signedDebitCents, 0), creditCents: Math.max(-signedDebitCents, 0) });

function finish(entry: Omit<JournalEntryOut, "debitCents" | "creditCents">): JournalEntryOut {
  const debitCents = entry.lines.reduce((s, l) => s + l.debitCents, 0);
  const creditCents = entry.lines.reduce((s, l) => s + l.creditCents, 0);
  return { ...entry, debitCents, creditCents };
}

// ---------------------------------------------------------------------------------------------
// Bills
// ---------------------------------------------------------------------------------------------

export interface BillInput {
  invoiceId: string;
  invoiceNumber: string | null;
  invoiceDate: string;
  vendorId: string | null;
  vendorName: string;
  currency: string;
  /** Invoice-date rate to CAD ("1" for CAD). */
  fxRate: string;
  totalCents: number;
  totalCadCents: number | null;
  /** Description per line number, for the line text. */
  lineDescriptions: ReadonlyMap<number, string>;
}

export function billEntry(bill: BillInput, journal: JournalPreview, accountName: (code: string) => string): Built {
  const exclude = (reason: string): Built => ({ ok: false, excluded: { entryType: "bill", id: bill.invoiceId, invoiceId: bill.invoiceId, vendorName: bill.vendorName, reason } });
  if (!journal.balanced) return exclude(`Its coding journal does not balance (off by ${(journal.differenceCents / 100).toFixed(2)} ${bill.currency}).`);
  const uncoded = journal.debits.filter((d) => !d.glAccount);
  if (uncoded.length) return exclude(`${uncoded.length} amount(s) have no account (an uncoded line or a tax with no code).`);
  if (!journal.credit.glAccount) return exclude("No Accounts Payable control account in the chart of accounts.");
  if (bill.totalCadCents === null) return exclude("No CAD total (missing exchange rate).");
  if (isOne(bill.fxRate) && bill.totalCadCents !== bill.totalCents) return exclude("Its CAD total differs from its total at a rate of 1.");

  // Debits to CAD: CAD bills as they are; others at the invoice-date rate, with any rounding cent
  // put on the largest line so the debits add up to the stored CAD total exactly.
  const cad = journal.debits.map((d) => (isOne(bill.fxRate) ? d.amountCents : toCad(d.amountCents, bill.fxRate)));
  const residual = bill.totalCadCents - cad.reduce((s, c) => s + c, 0);
  if (residual !== 0) {
    if (Math.abs(residual) > journal.debits.length) return exclude(`Converted lines miss the CAD total by ${(residual / 100).toFixed(2)} CAD (more than rounding).`);
    const largest = cad.reduce((best, c, i) => (Math.abs(c) > Math.abs(cad[best]!) ? i : best), 0);
    cad[largest]! += residual;
  }

  const entryId = `JE-BILL-${bill.invoiceId}`;
  const reference = bill.invoiceNumber ?? bill.invoiceId;
  const base = { entryId, entryDate: bill.invoiceDate, entryType: "bill" as const, invoiceId: bill.invoiceId, paymentId: null, vendorId: bill.vendorId, vendorName: bill.vendorName, reference, currency: bill.currency, fxRate: bill.fxRate };
  const KIND: Record<string, string> = { recoverable_tax: "input tax credit", non_recoverable_tax: "non-recoverable tax", unallocated_tax: "tax" };
  const lines: JournalLineOut[] = journal.debits.map((d, i) => ({
    ...base,
    glAccount: d.glAccount!,
    accountName: accountName(d.glAccount!),
    departmentId: d.departmentId,
    description:
      d.kind === "line"
        ? `${bill.vendorName} ${reference} · line ${d.lineNo}: ${bill.lineDescriptions.get(d.lineNo ?? -1) ?? ""}`.trim()
        : `${bill.vendorName} ${reference} · ${KIND[d.kind] ?? d.kind} ${d.taxCode ?? ""}${d.lineNo ? ` (line ${d.lineNo})` : ""}`.trim(),
    ...sides(cad[i]!),
    amountOriginalCents: d.amountCents,
  }));
  lines.push({
    ...base,
    glAccount: journal.credit.glAccount,
    accountName: accountName(journal.credit.glAccount),
    departmentId: null,
    description: `${bill.vendorName} ${reference} · accounts payable`,
    ...sides(-bill.totalCadCents),
    amountOriginalCents: -journal.credit.amountCents,
  });
  return { ok: true, entry: finish({ entryId, entryType: "bill", entryDate: bill.invoiceDate, invoiceId: bill.invoiceId, paymentId: null, vendorName: bill.vendorName, reference, lines }) };
}

// ---------------------------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------------------------

export interface PaymentInput {
  paymentId: string;
  invoiceId: string;
  invoiceNumber: string | null;
  vendorId: string | null;
  vendorName: string;
  /** EFT | CARD | CHEQUE */
  method: string;
  paidDate: string;
  reference: string | null;
  currency: string;
  amountCents: number;
  amountCadCents: number;
  /** In the payment's currency. */
  discountTakenCents: number;
  /** The payment's own rate to CAD. */
  fxRate: string;
  /** The BILL's invoice-date rate: Accounts Payable was credited at this rate. */
  invoiceFxRate: string | null;
}

export function paymentEntry(p: PaymentInput, apAccount: string | null, accountName: (code: string) => string): Built {
  const exclude = (reason: string): Built => ({ ok: false, excluded: { entryType: "payment", id: p.paymentId, invoiceId: p.invoiceId, vendorName: p.vendorName, reason } });
  if (!apAccount) return exclude("No Accounts Payable control account in the chart of accounts.");
  const billRate = p.invoiceFxRate ?? (p.currency === "CAD" ? "1" : null);
  if (!billRate) return exclude("The bill has no exchange rate, so the payable it clears cannot be valued in CAD.");

  const cleared = p.amountCents + p.discountTakenCents; // what this payment removes from the payable
  const paidCad = p.amountCadCents;
  const discountCad = isOne(billRate) ? p.discountTakenCents : toCad(p.discountTakenCents, billRate);
  // Same rate as the bill → no exchange difference by definition (no stray rounding cent).
  const sameRate = Number(billRate) === Number(p.fxRate) || isOne(billRate);
  const apCad = sameRate ? paidCad + discountCad : toCad(cleared, billRate);
  const fx = apCad - paidCad - discountCad; // > 0: paid fewer CAD than owed → gain (credit)

  const card = p.method.toUpperCase() === "CARD";
  const out = card ? JOURNAL_ACCOUNTS.card : JOURNAL_ACCOUNTS.bank;
  const entryId = `JE-PAY-${p.paymentId}`;
  const reference = p.reference ?? p.paymentId;
  const base = { entryId, entryDate: p.paidDate, entryType: "payment" as const, invoiceId: p.invoiceId, paymentId: p.paymentId, vendorId: p.vendorId, vendorName: p.vendorName, reference, currency: p.currency, fxRate: p.fxRate };
  const bill = p.invoiceNumber ?? p.invoiceId;
  const lines: JournalLineOut[] = [
    { ...base, glAccount: apAccount, accountName: accountName(apAccount), departmentId: null, description: `${p.vendorName} ${bill} · payment ${p.paymentId} clears the payable`, ...sides(apCad), amountOriginalCents: cleared },
    {
      ...base,
      glAccount: out.code,
      accountName: out.name,
      departmentId: null,
      description: `${p.vendorName} ${bill} · paid by ${card ? "Brim card" : p.method.toUpperCase() === "CHEQUE" ? "cheque" : "EFT"} (${reference})`,
      ...sides(-paidCad),
      amountOriginalCents: -p.amountCents,
    },
  ];
  if (discountCad !== 0) {
    lines.push({ ...base, glAccount: JOURNAL_ACCOUNTS.discount.code, accountName: JOURNAL_ACCOUNTS.discount.name, departmentId: null, description: `${p.vendorName} ${bill} · early-payment discount taken`, ...sides(-discountCad), amountOriginalCents: -p.discountTakenCents });
  }
  if (fx !== 0) {
    lines.push({ ...base, glAccount: FX_GAIN_LOSS_ACCOUNT, accountName: accountName(FX_GAIN_LOSS_ACCOUNT), departmentId: null, description: `${p.vendorName} ${bill} · exchange difference (bill at ${billRate}, paid at ${p.fxRate})`, ...sides(-fx), amountOriginalCents: 0 });
  }
  return { ok: true, entry: finish({ entryId, entryType: "payment", entryDate: p.paidDate, invoiceId: p.invoiceId, paymentId: p.paymentId, vendorName: p.vendorName, reference, lines }) };
}

// ---------------------------------------------------------------------------------------------
// CSV (what the accounting system imports)
// ---------------------------------------------------------------------------------------------

export const JOURNAL_CSV_COLUMNS = [
  "entry_id",
  "entry_date",
  "entry_type",
  "invoice_id",
  "payment_id",
  "vendor_id",
  "vendor_name",
  "reference",
  "gl_account",
  "account_name",
  "department",
  "description",
  "debit_cad",
  "credit_cad",
  "currency",
  "amount_original",
  "fx_rate",
] as const;

const amount = (cents: number) => {
  const sign = cents < 0 ? "-" : "";
  const a = Math.abs(cents);
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
};

/** RFC 4180 + spreadsheet-formula neutralising, as the audit export does. */
export function journalCsv(entries: readonly JournalEntryOut[], cell: (v: unknown) => string): string {
  const rows = [JOURNAL_CSV_COLUMNS.join(",")];
  for (const e of entries) {
    for (const l of e.lines) {
      rows.push(
        [
          l.entryId,
          l.entryDate,
          l.entryType,
          l.invoiceId,
          l.paymentId ?? "",
          l.vendorId ?? "",
          l.vendorName,
          l.reference,
          l.glAccount,
          l.accountName,
          l.departmentId ?? "",
          l.description,
          l.debitCents ? amount(l.debitCents) : "",
          l.creditCents ? amount(l.creditCents) : "",
          l.currency,
          amount(l.amountOriginalCents),
          l.fxRate,
        ]
          .map(cell)
          .join(","),
      );
    }
  }
  return rows.join("\r\n") + "\r\n";
}
