import type { JournalEntry, JournalPreview, LineCoding } from "@/contracts/coding";
import type { Flag } from "@/contracts/flag";
import type { ValidationInput } from "@/contracts/validation";
import { codingFlag } from "./codes";
import type { CodingContext } from "./context";
import { formatMoney } from "./text";

/**
 * The journal entry the coding produces, so a person sees the effect before it is posted:
 *
 *   Dr  each line's account / department          line amount
 *   Dr  1160 GST/HST · 1165 QST receivable         recoverable tax (an input tax credit, not a cost)
 *   Dr  the goods lines' accounts                  their share of non-recoverable tax (BC PST is a cost)
 *     Cr  2100 Accounts Payable                    invoice total
 *
 * Recoverability, receivable accounts and "goods only" all come from tax_codes; nothing here
 * names a rate or an account. Non-recoverable tax is spread by line amount with the
 * largest-remainder method, so the pieces add up to the tax exactly (no lost or extra cent).
 * Amounts are signed and in invoice currency: a credit note's entry is the mirror image.
 */

type JournalInput = Pick<ValidationInput, "currency" | "taxes" | "totalCents">;
type JournalLine = Pick<LineCoding, "lineNo" | "amountCents" | "lineType" | "glAccount" | "departmentId">;

/** Splits `total` across `weights` in proportion, exactly (largest remainder; ties → earlier). */
export function allocate(total: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  const sign = total < 0 ? -1n : 1n;
  const amount = BigInt(Math.abs(total));
  const w = weights.map((x) => BigInt(Math.abs(Math.round(x))));
  const sum = w.reduce((a, b) => a + b, 0n);
  const shares = sum === 0n ? weights.map(() => 1n) : w;
  const den = sum === 0n ? BigInt(weights.length) : sum;
  const base = shares.map((s) => (amount * s) / den);
  let left = amount - base.reduce((a, b) => a + b, 0n);
  const order = shares
    .map((s, i) => ({ i, rem: (amount * s) % den }))
    .sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : a.i - b.i));
  for (const { i } of order) {
    if (left === 0n) break;
    base[i]! += 1n;
    left -= 1n;
  }
  return base.map((b) => Number(b * sign));
}

const isZeroRate = (rate: string) => /^0*(\.0*)?$/.test(rate.trim());

export function buildJournal(input: JournalInput, lines: readonly JournalLine[], ctx: CodingContext): { journal: JournalPreview; flags: Flag[] } {
  const flags: Flag[] = [];
  const debits: JournalEntry[] = lines.map((l) => ({
    glAccount: l.glAccount,
    departmentId: l.departmentId,
    amountCents: l.amountCents,
    kind: "line",
    lineNo: l.lineNo,
    taxCode: null,
  }));
  const money = (c: number) => formatMoney(c, input.currency);
  const unplaced = (amountCents: number, taxCode: string | null, why: string) => {
    debits.push({ glAccount: null, departmentId: null, amountCents, kind: "unallocated_tax", lineNo: null, taxCode });
    flags.push(codingFlag("CODING_TAX_UNALLOCATED", why, { field: "taxes", taxCode, amountCents }));
  };

  for (const tax of input.taxes) {
    if (tax.amountCents === 0) continue;
    const ref = tax.code ? ctx.taxCodes.get(tax.code) : undefined;
    if (!ref) {
      unplaced(tax.amountCents, tax.code, `Tax "${tax.label}" of ${money(tax.amountCents)} has no known tax code, so the journal cannot place it; map it to a tax code first.`);
      continue;
    }
    if (ref.recoverable.trim().toLowerCase() === "yes" && ref.glAccount) {
      debits.push({ glAccount: ref.glAccount, departmentId: null, amountCents: tax.amountCents, kind: "recoverable_tax", lineNo: null, taxCode: ref.code });
      continue;
    }
    if (isZeroRate(ref.rate)) {
      unplaced(tax.amountCents, ref.code, `${money(tax.amountCents)} was charged under ${ref.code}, a zero-rate code, so the journal cannot place it.`);
      continue;
    }
    // Not recoverable: part of the cost of the lines it was charged on.
    const goodsOnly = ref.appliesTo.trim().toLowerCase() === "goods";
    const goods = lines.filter((l) => l.lineType === "goods");
    const over = goodsOnly && goods.length > 0 ? goods : lines;
    if (over.length === 0) {
      unplaced(tax.amountCents, ref.code, `${ref.code} of ${money(tax.amountCents)} cannot be spread: the invoice has no lines.`);
      continue;
    }
    const shares = allocate(tax.amountCents, over.map((l) => l.amountCents));
    over.forEach((l, i) => {
      debits.push({ glAccount: l.glAccount, departmentId: l.departmentId, amountCents: shares[i]!, kind: "non_recoverable_tax", lineNo: l.lineNo, taxCode: ref.code });
    });
  }

  const debitTotal = debits.reduce((sum, d) => sum + d.amountCents, 0);
  const creditAmount = input.totalCents ?? debitTotal;
  const differenceCents = creditAmount - debitTotal;
  if (differenceCents !== 0) {
    flags.push(
      codingFlag(
        "CODING_JOURNAL_UNBALANCED",
        `Lines and taxes add up to ${money(debitTotal)} but the invoice total is ${money(creditAmount)} (off by ${money(differenceCents)}); the entry would not balance — correct the extraction before posting.`,
        { field: "journal", debitCents: debitTotal, creditCents: creditAmount, differenceCents },
      ),
    );
  }
  return {
    journal: {
      currency: input.currency,
      debits,
      credit: { glAccount: ctx.apControlAccount, amountCents: creditAmount },
      balanced: differenceCents === 0,
      differenceCents,
    },
    flags,
  };
}
