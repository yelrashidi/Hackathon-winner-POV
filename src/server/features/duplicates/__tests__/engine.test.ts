import { describe, expect, it } from "vitest";
import { checkDuplicates, compareNumbers, canonicalNumber, matchMerchant, type CardTxnRef, type DuplicateContext, type InvoiceOnRecord } from "..";
import { incomingToRecord, loadDatasetDuplicateContext } from "../dataset";
import { loadIncomingFixtures } from "@/server/features/validation/dataset/batch";
import { loadDatasetContext } from "@/server/features/validation/dataset/load-context";

// Synthetic records: no dataset values in the rule tests (CLAUDE.md rule 4).
const inv = (o: Partial<InvoiceOnRecord> & { invoiceId: string }): InvoiceOnRecord => ({
  vendorId: "V1",
  invoiceNumber: "A-100",
  invoiceDate: "2026-05-01",
  receivedDate: "2026-05-02",
  currency: "CAD",
  totalCents: 100_000,
  totalCadCents: 100_000,
  status: "InReview",
  isCreditNote: false,
  documentSha256: null,
  createdAt: null,
  ...o,
});
const card = (o: Partial<CardTxnRef> & { id: string }): CardTxnRef => ({
  postedDate: "2026-05-05",
  merchantDescriptor: "ACME WIDGET SUPPLY",
  amountCents: 100_000,
  currency: "CAD",
  amountCadCents: 100_000,
  source: "employee_card",
  cardholderId: "U9",
  vendorId: null,
  ...o,
});
const ctxOf = (invoices: InvoiceOnRecord[], cardTransactions: CardTxnRef[] = []): DuplicateContext => ({
  invoices,
  cardTransactions,
  vendors: [
    { id: "V1", legalName: "Acme Widget Supply Ltd." },
    { id: "V2", legalName: "Other Freight Inc." },
  ],
});
const codes = (r: ReturnType<typeof checkDuplicates>) => r.flags.map((f) => f.code);

describe("invoice numbers", () => {
  it.each([
    ["ST-4471", "ST4471", "same"],
    ["st 4471", "ST-4471", "same"],
    ["000604", "604", "same"],
    ["INV-02990", "inv 2990", "same"],
    ["000903", "000903-A", "variant"],
    ["FA-001655", "1655-A", "variant"],
    ["INV-01536", "INV-01537", "different"],
    ["12", "12A", "different"], // too short to call a variant
    ["", "123", "different"],
  ])("%s vs %s → %s", (a, b, rel) => expect(compareNumbers(a, b)).toBe(rel));

  it("canonical form drops punctuation, case and leading zeros of each digit run", () => {
    expect(canonicalNumber("fa-000583")).toBe("FA583");
  });
});

describe("checkDuplicates — invoice vs invoice", () => {
  const original = inv({ invoiceId: "OLD", status: "Paid", receivedDate: "2026-04-01", invoiceDate: "2026-04-01" });

  it("same vendor + reformatted number is DUPLICATE_INVOICE even with a shifted date", () => {
    const copy = inv({ invoiceId: "NEW", invoiceNumber: "a 100", invoiceDate: "2026-05-01" });
    const r = checkDuplicates(copy, ctxOf([original, copy]));
    expect(codes(r)).toEqual(["DUPLICATE_INVOICE"]);
    expect(r.flags[0]!.relatedInvoiceId).toBe("OLD");
    expect(r.flags[0]!.message).toContain("$1,000.00");
    expect(r.flags[0]!.message).toContain("date differs");
    expect(r.blocking).toBe(true);
  });

  it("flags only the second copy, never the original", () => {
    const copy = inv({ invoiceId: "NEW" });
    expect(checkDuplicates(original, ctxOf([original, copy])).flags).toEqual([]);
  });

  it("same received date: the one created later is the copy", () => {
    const a = inv({ invoiceId: "A", createdAt: "2026-05-02T10:00:00Z" });
    const b = inv({ invoiceId: "B", createdAt: "2026-05-02T11:00:00Z" });
    expect(codes(checkDuplicates(b, ctxOf([a, b])))).toEqual(["DUPLICATE_INVOICE"]);
    expect(codes(checkDuplicates(a, ctxOf([a, b])))).toEqual([]);
  });

  it("a number variant needs the same amount or date", () => {
    const sameAmount = inv({ invoiceId: "N1", invoiceNumber: "A-100-B", invoiceDate: "2026-06-15" });
    expect(codes(checkDuplicates(sameAmount, ctxOf([original])))).toEqual(["DUPLICATE_NUMBER_VARIANT"]);
    const neither = inv({ invoiceId: "N2", invoiceNumber: "A-100-B", invoiceDate: "2026-06-15", totalCents: 5, totalCadCents: 5 });
    expect(codes(checkDuplicates(neither, ctxOf([original])))).toEqual([]);
  });

  it("same amount under another number is only a warning, and only within the window", () => {
    const near = inv({ invoiceId: "N", invoiceNumber: "Z-9", invoiceDate: "2026-04-04" });
    const r = checkDuplicates(near, ctxOf([original]));
    expect(codes(r)).toEqual(["DUPLICATE_SUSPECTED"]);
    expect(r.blocking).toBe(false);
    // a monthly fixed fee: same amount a month later is NOT a duplicate
    const monthly = inv({ invoiceId: "M", invoiceNumber: "Z-10", invoiceDate: "2026-05-01" });
    expect(codes(checkDuplicates(monthly, ctxOf([original])))).toEqual([]);
  });

  it("same file hash is a duplicate even when the vendor was not matched", () => {
    const a = inv({ invoiceId: "A", documentSha256: "abc", receivedDate: "2026-04-01" });
    const b = inv({ invoiceId: "B", documentSha256: "abc", vendorId: null, invoiceNumber: null });
    expect(codes(checkDuplicates(b, ctxOf([a, b])))).toEqual(["DUPLICATE_DOCUMENT"]);
  });

  it("ignores other vendors, voided / rejected invoices, and credit notes vs invoices", () => {
    const copy = inv({ invoiceId: "NEW" });
    const others = [
      { ...original, invoiceId: "X1", vendorId: "V2" },
      { ...original, invoiceId: "X2", status: "Voided" },
      { ...original, invoiceId: "X3", status: "rejected" },
      { ...original, invoiceId: "X4", isCreditNote: true, totalCents: -100_000, totalCadCents: -100_000 },
    ];
    expect(checkDuplicates(copy, ctxOf(others)).flags).toEqual([]);
  });

  it("one flag per earlier invoice, identified by it across re-runs", () => {
    const second = { ...original, invoiceId: "OLD2", receivedDate: "2026-04-10" };
    const copy = inv({ invoiceId: "NEW" });
    const r = checkDuplicates(copy, ctxOf([original, second]));
    expect(r.flags.map((f) => (f.evidence as { field: string }).field).sort()).toEqual(["related:OLD", "related:OLD2"]);
  });
});

describe("checkDuplicates — duplicate and probable split, both facts", () => {
  const limits = { approvalThresholdsCadCents: [500_000, 1_000_000] }; // $5,000 and $10,000
  const first = inv({ invoiceId: "OLD", status: "Paid", receivedDate: "2026-04-01", invoiceDate: "2026-04-01", totalCents: 700_000, totalCadCents: 700_000 });

  it("same-number pair whose sum crosses a limit gets the duplicate flag AND the split fact", () => {
    const copy = inv({ invoiceId: "NEW", invoiceDate: "2026-04-02", totalCents: 700_000, totalCadCents: 700_000 });
    const r = checkDuplicates(copy, { ...ctxOf([first, copy]), ...limits });
    expect(codes(r)).toEqual(["DUPLICATE_INVOICE", "SPLIT_IF_NOT_DUPLICATE"]);
    const split = r.flags[1]!;
    expect(split.severity).toBe("warn");
    expect(split.relatedInvoiceId).toBe("OLD");
    expect(split.evidence).toMatchObject({ combinedCadCents: 1_400_000, thresholdCadCents: 1_000_000 });
    expect(split.message).toContain("$14,000.00");
    expect(split.message).toContain("$10,000.00");
  });

  it("no split fact when the sum stays under every limit, the dates are far apart, or no limits are known", () => {
    const small = inv({ invoiceId: "S", invoiceDate: "2026-04-02", totalCents: 100_000, totalCadCents: 100_000 });
    const smallFirst = { ...first, totalCents: 100_000, totalCadCents: 100_000 };
    expect(codes(checkDuplicates(small, { ...ctxOf([smallFirst]), ...limits }))).toEqual(["DUPLICATE_INVOICE"]);
    const late = inv({ invoiceId: "L", invoiceDate: "2026-05-01", totalCents: 700_000, totalCadCents: 700_000 });
    expect(codes(checkDuplicates(late, { ...ctxOf([first]), ...limits }))).toEqual(["DUPLICATE_INVOICE"]);
    const copy = inv({ invoiceId: "N", invoiceDate: "2026-04-02", totalCents: 700_000, totalCadCents: 700_000 });
    expect(codes(checkDuplicates(copy, ctxOf([first])))).toEqual(["DUPLICATE_INVOICE"]);
  });

  it("no split fact for a different-number pair: validation's own split check already counts it", () => {
    const other = inv({ invoiceId: "D", invoiceNumber: "Z-9", invoiceDate: "2026-04-02", totalCents: 700_000, totalCadCents: 700_000 });
    expect(codes(checkDuplicates(other, { ...ctxOf([first]), ...limits }))).toEqual(["DUPLICATE_SUSPECTED"]);
  });
});

describe("checkDuplicates — already paid by card", () => {
  const bill = inv({ invoiceId: "NEW" });

  it("matches a charge at this vendor (merchant name) for the same amount near the invoice date", () => {
    const r = checkDuplicates(bill, ctxOf([], [card({ id: "CT1" })]));
    expect(codes(r)).toEqual(["ALREADY_PAID_BY_CARD"]);
    expect(r.flags[0]!.relatedCardTxnId).toBe("CT1");
    expect(r.flags[0]!.evidence).toMatchObject({ merchantMatch: "prefix", daysFromInvoiceDate: 4 });
  });

  it("a truncated descriptor still matches by prefix", () => {
    expect(matchMerchant("ACME WIDGET SUP", ctxOf([]).vendors)?.vendorId).toBe("V1");
  });

  it("skips other amounts, other vendors, far dates and AP's own virtual-card payments", () => {
    const cards = [
      card({ id: "C1", amountCents: 99_999, amountCadCents: 99_999 }),
      card({ id: "C2", merchantDescriptor: "OTHER FREIGHT" }),
      card({ id: "C3", postedDate: "2026-08-01" }),
      card({ id: "C4", source: "ap_virtual_card" }),
      card({ id: "C5", merchantDescriptor: "COFFEE SHOP" }),
    ];
    expect(checkDuplicates(bill, ctxOf([], cards)).flags).toEqual([]);
  });

  it("a USD invoice matches on the CAD amount", () => {
    const usd = inv({ invoiceId: "U", currency: "USD", totalCents: 75_000, totalCadCents: 102_500 });
    expect(codes(checkDuplicates(usd, ctxOf([], [card({ id: "C", amountCents: 102_500, amountCadCents: 102_500 })])))).toEqual(["ALREADY_PAID_BY_CARD"]);
  });
});

describe("on the dataset", () => {
  const base = loadDatasetDuplicateContext();

  it("history: flags every repeated vendor + number, on the later copy only", { timeout: 30_000 }, () => {
    const flagged = base.invoices.map((i) => checkDuplicates(i, base)).filter((r) => r.flags.some((f) => f.code.startsWith("DUPLICATE_")));
    const pairs = flagged.flatMap((r) => r.flags.filter((f) => f.code.startsWith("DUPLICATE_")).map((f) => `${f.relatedInvoiceId}→${r.invoiceId}`));
    expect(pairs.length).toBe(7); // 6 same-number pairs + 1 reformatted ("1655-A")
    // every flagged invoice came after the one it points at
    for (const p of pairs) {
      const [a, b] = p.split("→");
      expect(a! < b!).toBe(true);
    }
    // no fixed monthly fee is mistaken for a duplicate
    expect(flagged.flatMap((r) => r.flags).filter((f) => f.code === "DUPLICATE_SUSPECTED")).toEqual([]);
  });

  it("incoming batch: the three duplicates the validation fixtures leave to feature 5 are flagged", () => {
    const vctx = loadDatasetContext();
    const fixtures = loadIncomingFixtures();
    const batch = fixtures.map(({ fixture }) => incomingToRecord(fixture.input, vctx));
    const ctx = { ...base, invoices: [...base.invoices, ...batch] };
    const byFile = new Map(fixtures.map(({ file }, i) => [file, checkDuplicates(batch[i]!, ctx)]));
    for (const file of ["cloudbarnsoftwar-inv01561.json", "harlowsternllp-001468.json", "voyageurcorporat-inv-017.json"]) {
      expect(byFile.get(file)!.blocking, file).toBe(true);
    }
  });
});
