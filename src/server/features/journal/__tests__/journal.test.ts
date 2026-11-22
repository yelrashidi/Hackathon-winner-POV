import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/contracts/actor";
import type { JournalPreview as CodingJournal } from "@/contracts/coding";
import { Forbidden } from "@/server/core/authorize";
import type { Db } from "@/server/db/client";
import { createSeededDb } from "@/server/db/__tests__/helpers";
import { csvCell } from "@/server/features/audit";
import { billEntry, exportJournal, journalCsv, journalExports, JournalExportError, paymentEntry, previewJournal, toCad, type JournalEntryOut } from "..";

/**
 * The accounting journal export (bonus): every entry balances, amounts are exact CAD cents, bills
 * and payments map to the right accounts, nothing half-right is exported, only the Finance Manager
 * and the Controller/Admin may export, and an export is recorded so it is never posted twice.
 */

const name = (code: string) => `acct ${code}`;
const journal = (debits: CodingJournal["debits"], total: number, balanced = true): CodingJournal => ({
  currency: "CAD",
  debits,
  credit: { glAccount: "2100", amountCents: total },
  balanced,
  differenceCents: balanced ? 0 : 1,
});
const line = (lineNo: number, glAccount: string | null, amountCents: number, departmentId = "D01") => ({ glAccount, departmentId, amountCents, kind: "line" as const, lineNo, taxCode: null });
const tax = (glAccount: string, amountCents: number, code = "HST13") => ({ glAccount, departmentId: null, amountCents, kind: "recoverable_tax" as const, lineNo: null, taxCode: code });
const bill = (over: Partial<Parameters<typeof billEntry>[0]> = {}): Parameters<typeof billEntry>[0] => ({
  invoiceId: "INV-1",
  invoiceNumber: "A-1",
  invoiceDate: "2026-10-05",
  vendorId: "V001",
  vendorName: "Polar Freight Lines Ltd.",
  currency: "CAD",
  fxRate: "1",
  totalCents: 113000,
  totalCadCents: 113000,
  lineDescriptions: new Map([[1, "LTL shipment"]]),
  ...over,
});
const sum = (e: JournalEntryOut, k: "debitCents" | "creditCents") => e.lines.reduce((s, l) => s + l[k], 0);

describe("toCad: cents × rate, exactly", () => {
  it("rounds half away from zero, keeps the sign, never uses a float product", () => {
    expect(toCad(480000, "1.3709")).toBe(658032);
    expect(toCad(32423, "1.3709")).toBe(44449); // 44448.6907 → 44449
    expect(toCad(-32423, "1.3709")).toBe(-44449);
    expect(toCad(1, "0.5")).toBe(1);
    expect(toCad(100, "1")).toBe(100);
    expect(() => toCad(100, "1.2e3")).toThrow();
  });
});

describe("bill entries", () => {
  it("CAD: lines and recoverable tax are debits, Accounts Payable is the credit, and it balances", () => {
    const r = billEntry(bill(), journal([line(1, "5010", 100000), tax("1160", 13000)], 113000), name);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.lines.map((l) => [l.glAccount, l.debitCents, l.creditCents])).toEqual([
      ["5010", 100000, 0],
      ["1160", 13000, 0],
      ["2100", 0, 113000],
    ]);
    expect(r.entry.lines[0]!.departmentId).toBe("D01");
    expect(r.entry.debitCents).toBe(r.entry.creditCents);
  });

  it("USD: converted at the invoice-date rate and pinned to the stored CAD total (no lost cent)", () => {
    const r = billEntry(bill({ currency: "USD", fxRate: "1.3709", totalCents: 512423, totalCadCents: 702481 }), journal([line(1, "6130", 480000), line(2, "6130", 32423)], 512423), name);
    expect(r.ok && [sum(r.entry, "debitCents"), sum(r.entry, "creditCents")]).toEqual([702481, 702481]);
    if (r.ok) expect(r.entry.lines[0]).toMatchObject({ amountOriginalCents: 480000, fxRate: "1.3709", currency: "USD" });
  });

  it("a credit note is the mirror image: expenses are credited, Accounts Payable is debited", () => {
    const r = billEntry(bill({ totalCents: -67200, totalCadCents: -67200 }), journal([line(1, "5010", -67200)], -67200), name);
    expect(r.ok && r.entry.lines.map((l) => [l.glAccount, l.debitCents, l.creditCents])).toEqual([
      ["5010", 0, 67200],
      ["2100", 67200, 0],
    ]);
  });

  it("a bill whose coding does not balance, or has an uncoded line, is excluded with the reason — never half-exported", () => {
    const off = billEntry(bill(), journal([line(1, "5010", 100000)], 113000, false), name);
    expect(off).toMatchObject({ ok: false, excluded: { reason: expect.stringMatching(/does not balance/) } });
    const uncoded = billEntry(bill(), journal([line(1, null, 113000)], 113000), name);
    expect(uncoded).toMatchObject({ ok: false, excluded: { reason: expect.stringMatching(/no account/) } });
    const noCad = billEntry(bill({ currency: "USD", fxRate: "1.37", totalCadCents: null }), journal([line(1, "5010", 113000)], 113000), name);
    expect(noCad).toMatchObject({ ok: false, excluded: { reason: expect.stringMatching(/No CAD total/) } });
  });
});

describe("payment entries", () => {
  const pay = (over: Partial<Parameters<typeof paymentEntry>[0]> = {}): Parameters<typeof paymentEntry>[0] => ({
    paymentId: "PAY-1",
    invoiceId: "INV-1",
    invoiceNumber: "A-1",
    vendorId: "V001",
    vendorName: "Polar Freight Lines Ltd.",
    method: "EFT",
    paidDate: "2026-10-20",
    reference: "EFT-123",
    currency: "CAD",
    amountCents: 113000,
    amountCadCents: 113000,
    discountTakenCents: 0,
    fxRate: "1",
    invoiceFxRate: "1",
    ...over,
  });
  const rows = (r: ReturnType<typeof paymentEntry>) => (r.ok ? r.entry.lines.map((l) => [l.glAccount, l.debitCents, l.creditCents]) : r.excluded.reason);

  it("EFT: Dr Accounts Payable, Cr the bank", () => {
    expect(rows(paymentEntry(pay(), "2100", name))).toEqual([
      ["2100", 113000, 0],
      ["1010", 0, 113000],
    ]);
  });

  it("Brim card: the debt moves to the card account, not the bank", () => {
    expect(rows(paymentEntry(pay({ method: "CARD" }), "2100", name))).toEqual([
      ["2100", 113000, 0],
      ["2150", 0, 113000],
    ]);
  });

  it("early-payment discount: the payable is cleared in full, the bank pays less, the difference is income", () => {
    expect(rows(paymentEntry(pay({ amountCents: 204232, amountCadCents: 204232, discountTakenCents: 3713 }), "2100", name))).toEqual([
      ["2100", 207945, 0],
      ["1010", 0, 204232],
      ["4910", 0, 3713],
    ]);
  });

  it("USD paid at a different rate: the payable at the bill's rate, the bank at the payment's, the difference to 7020", () => {
    const r = paymentEntry(pay({ currency: "USD", amountCents: 100000, amountCadCents: 140000, fxRate: "1.40", invoiceFxRate: "1.37" }), "2100", name);
    expect(rows(r)).toEqual([
      ["2100", 137000, 0],
      ["1010", 0, 140000],
      ["7020", 3000, 0], // paid 3,000 more CAD than owed: an exchange loss
    ]);
  });

  it("USD at the bill's own rate: no exchange line at all (no stray rounding cent)", () => {
    const r = paymentEntry(pay({ currency: "USD", amountCents: 512423, amountCadCents: 702481, fxRate: "1.3709", invoiceFxRate: "1.3709" }), "2100", name);
    expect(rows(r)).toEqual([
      ["2100", 702481, 0],
      ["1010", 0, 702481],
    ]);
  });

  it("a bill with no exchange rate cannot be valued: excluded", () => {
    expect(paymentEntry(pay({ currency: "USD", invoiceFxRate: null, fxRate: "1.4" }), "2100", name)).toMatchObject({ ok: false });
  });
});

describe("the CSV", () => {
  it("one row per line, amounts as plain decimals, formula-like text neutralised", () => {
    const r = billEntry(bill({ vendorName: "=HYPERLINK(evil)" }), journal([line(1, "5010", 100000), tax("1160", 13000)], 113000), name);
    if (!r.ok) throw new Error("expected an entry");
    const csv = journalCsv([r.entry], csvCell).trim().split("\r\n");
    expect(csv).toHaveLength(4);
    expect(csv[0]).toBe("entry_id,entry_date,entry_type,invoice_id,payment_id,vendor_id,vendor_name,reference,gl_account,account_name,department,description,debit_cad,credit_cad,currency,amount_original,fx_rate");
    expect(csv[1]).toContain(",1000.00,,CAD,1000.00,1");
    expect(csv[1]).toContain("'=HYPERLINK(evil)");
  });
});

describe("on the database", () => {
  let db: Db;
  let client: PGlite;
  const FM: Actor = { userId: "U003", role: "finance_manager" };
  const ADMIN: Actor = { userId: "U002", role: "controller_admin" };
  const OCTOBER = { from: "2026-10-01", to: "2026-10-31" };

  beforeAll(async () => {
    ({ db, client } = await createSeededDb());
  }, 120_000);

  it("only the Finance Manager and the Controller/Admin may preview or export; a refusal is logged", async () => {
    for (const actor of [
      { userId: "U004", role: "ap_clerk" },
      { userId: "U007", role: "approver" },
      { userId: "U006", role: "auditor" },
    ] satisfies Actor[]) {
      await expect(previewJournal(actor, OCTOBER, { db })).rejects.toBeInstanceOf(Forbidden);
      await expect(exportJournal(actor, OCTOBER, { db })).rejects.toBeInstanceOf(Forbidden);
    }
    const denied = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_events WHERE action = 'authz.denied' AND metadata->>'attempted' = 'journal.export'");
    expect(denied.rows[0]!.n).toBeGreaterThanOrEqual(6);
  });

  it("a period's bills (approved or later, by invoice date) and settled payments (by paid date), all balanced", async () => {
    const p = await previewJournal(FM, OCTOBER, { db });
    const bills = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM invoices WHERE status IN ('Approved','PaymentScheduled','Paid') AND invoice_date BETWEEN '2026-10-01' AND '2026-10-31'");
    const pays = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM payments WHERE status = 'settled' AND paid_date BETWEEN '2026-10-01' AND '2026-10-31'");
    expect(p.totals.bills + p.excluded.filter((e) => e.entryType === "bill").length).toBe(bills.rows[0]!.n);
    expect(p.totals.payments + p.excluded.filter((e) => e.entryType === "payment").length).toBe(pays.rows[0]!.n);
    expect(p.totals.balanced).toBe(true);
    expect(p.entries.every((e) => e.debitCents === e.creditCents && e.debitCents > 0)).toBe(true);
    expect(p.entries.every((e) => e.entryDate >= OCTOBER.from && e.entryDate <= OCTOBER.to)).toBe(true);
    // Every bill credits Accounts Payable for its CAD total.
    const [ap] = (await client.query<{ s: string }>("SELECT sum(total_cad_cents)::text AS s FROM invoices WHERE status IN ('Approved','PaymentScheduled','Paid') AND invoice_date BETWEEN '2026-10-01' AND '2026-10-31'")).rows;
    const apCredits = p.entries.filter((e) => e.entryType === "bill").flatMap((e) => e.lines).filter((l) => l.glAccount === "2100").reduce((s, l) => s + l.creditCents - l.debitCents, 0);
    expect(apCredits).toBe(Number(ap!.s));
  });

  it("exporting records who posted what, and the next 'only new' export skips it; a full re-download still works", async () => {
    const first = await exportJournal(FM, OCTOBER, { db });
    expect(first.csv.trim().split("\r\n")).toHaveLength(first.preview.totals.lines + 1);
    const again = await previewJournal(ADMIN, OCTOBER, { db });
    expect(again.entries).toHaveLength(0);
    expect(again.alreadyExported).toBe(first.preview.entries.length);
    await expect(exportJournal(ADMIN, OCTOBER, { db })).rejects.toBeInstanceOf(JournalExportError);
    const full = await previewJournal(ADMIN, { ...OCTOBER, onlyNew: false }, { db });
    expect(full.entries).toHaveLength(first.preview.entries.length);

    const history = await journalExports(ADMIN, { db });
    expect(history[0]).toMatchObject({ exportId: first.exportId, by: { userId: "U003" }, from: OCTOBER.from, to: OCTOBER.to, bills: first.preview.totals.bills });
    const [ev] = (await client.query<{ actor_id: string; metadata: { billIds: string[]; paymentIds: string[] } }>("SELECT actor_id, metadata FROM audit_events WHERE action = 'journal.exported' ORDER BY id DESC LIMIT 1")).rows;
    expect(ev!.actor_id).toBe("U003");
    expect(ev!.metadata.billIds.length + ev!.metadata.paymentIds.length).toBe(first.preview.entries.length);
  });

  it("bills only / payments only", async () => {
    const billsOnly = await previewJournal(FM, { from: "2026-09-01", to: "2026-09-30", payments: false }, { db });
    expect(billsOnly.entries.every((e) => e.entryType === "bill")).toBe(true);
    const paysOnly = await previewJournal(FM, { from: "2026-09-01", to: "2026-09-30", bills: false }, { db });
    expect(paysOnly.entries.every((e) => e.entryType === "payment")).toBe(true);
    expect(billsOnly.entries.length).toBeGreaterThan(0);
    expect(paysOnly.entries.length).toBeGreaterThan(0);
  });
});
