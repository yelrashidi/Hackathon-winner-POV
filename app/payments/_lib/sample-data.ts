// ---------------------------------------------------------------------------
// TEMP: SAMPLE DATA — NOT REAL PAYMENTS.
// Vendors, people, invoice numbers and amounts come from brim_ap_dataset, but the payment
// statuses, dates, failures and retries are made up for the dashboard demo. SAMPLE-AP-90001
// is fully invented (the dataset has no invoice over $100k CAD).
// Delete this file when getPayments() switches to the format in docs/payment-data.md.
// ---------------------------------------------------------------------------

import type { InvoiceRecord, PaymentRecord, Person } from "./types";

const PRIYA: Person = { userId: "U001", name: "Priya Raman" }; // controller
const MARCUS: Person = { userId: "U002", name: "Marcus Webb" }; // controller
const ELISE: Person = { userId: "U003", name: "Elise Tremblay" }; // finance manager
const JORDAN: Person = { userId: "U004", name: "Jordan Okafor" }; // AP clerk
const SAM: Person = { userId: "U005", name: "Sam Patel" }; // AP clerk
const DEV: Person = { userId: "U007", name: "Dev Malhotra" };
const CHLOE: Person = { userId: "U008", name: "Chloe Bergeron" };
const WEN: Person = { userId: "U010", name: "Wen Zhao" };
const GRACE: Person = { userId: "U011", name: "Grace Mbeki" };
const LIAM: Person = { userId: "U012", name: "Liam O'Connor" };

export const SAMPLE_INVOICES: InvoiceRecord[] = [
  inv("AP-00394", "000804", "V011", "Summit Packaging Supply", 245719, "2026-11-16", [DEV], "paid"),
  inv("AP-00407", "000804", "V011", "Summit Packaging Supply", 245719, "2026-11-16", [DEV], "approved"),
  inv("AP-00396", "FA-000554", "V027", "Beaumont Rivière S.E.N.C.R.L.", 92941, "2026-11-24", [PRIYA, ELISE], "payment_scheduled"),
  inv("AP-00398", "KE26-1196", "V012", "Keystone Racking Systems", 941516, "2026-11-20", [DEV], "payment_scheduled"),
  inv("AP-00399", "FA-000315", "V020", "Quillpad Documents Ltd.", 48300, "2026-11-13", [MARCUS], "paid"),
  inv("AP-00401", "554", "V019", "Lattice Ledger Systems", 138600, "2026-11-17", [MARCUS], "paid"),
  {
    ...inv("AP-00405", "FA-002337", "V018", "Sparkgrid CRM Inc.", 195000, "2026-11-20", [CHLOE], "payment_scheduled"),
    currency: "USD",
    totalCadCents: 263367,
  },
  inv("AP-00408", "PI26-2805", "V017", "Pinecone Collaboration Ltd.", 81900, "2026-11-26", [WEN], "payment_scheduled"),
  inv("AP-00411", "INV-01567", "V015", "Cloudbarn Software Inc.", 252000, "2026-11-14", [WEN], "paid"),
  inv("AP-00414", "INV-00732", "V045", "ClearView Janitorial", 254250, "2026-11-19", [LIAM], "approved"),
  inv("AP-00415", "GR26-2267", "V002", "Great Lakes Carriers Inc.", 304745, "2026-11-20", [DEV], "approved"),
  inv("AP-00417", "FA-002393", "V005", "Laurentian Logistics Inc.", 408147, "2026-11-25", [DEV], "payment_scheduled"),
  inv("AP-00418", "INV-03017", "V040", "Lakeshore Hydro Services", 201113, "2026-11-18", [LIAM], "approved"),
  inv("AP-00419", "FA-000790", "V048", "Talentbridge Recruiting", 741718, "2026-11-21", [GRACE], "payment_scheduled"),
  inv("AP-00420", "FA-001617", "V003", "Prairie Express Haulage", 441044, "2026-11-27", [DEV], "payment_scheduled"),
  inv("AP-00421", "850", "V014", "Hardhat Outfitters Ltd.", 687811, "2026-11-16", [DEV], "paid"),
  inv("AP-00422", "FA-000793", "V048", "Talentbridge Recruiting", 1658173, "2026-11-28", [GRACE, ELISE], "payment_scheduled"),
  inv("AP-00424", "FA-001681", "V008", "Redline Fleet Cards Inc.", 473135, "2026-11-12", [DEV], "paid"),
  inv("SAMPLE-AP-90001", "INV-SAMPLE-01", "V030", "Brightmore Consulting Group", 12840000, "2026-11-30", [DEV, ELISE, MARCUS], "payment_scheduled"),
  // Approved, no payment scheduled yet → "Awaiting payment".
  inv("AP-00425", "000638", "V006", "Northbound Couriers", 371634, "2026-11-23", [DEV], "approved"),
  inv("AP-00426", "1619", "V004", "Cascadia Cartage Ltd.", 256392, "2026-11-23", [DEV], "approved"),
];

export const SAMPLE_PAYMENTS: PaymentRecord[] = [
  // settled
  pay("SAMPLE-PAY-001", "AP-00394", 1, "settled", 245719, "2026-11-13", SAM, { releasedAt: "2026-11-13", settledAt: "2026-11-14", releasedBy: ELISE }),
  pay("SAMPLE-PAY-002", "AP-00399", 1, "settled", 48300, "2026-11-12", SAM, { releasedAt: "2026-11-12", settledAt: "2026-11-13", releasedBy: ELISE }),
  pay("SAMPLE-PAY-003", "AP-00411", 1, "settled", 252000, "2026-11-13", JORDAN, { releasedAt: "2026-11-13", settledAt: "2026-11-14", releasedBy: ELISE }),
  pay("SAMPLE-PAY-004", "AP-00421", 1, "settled", 687811, "2026-11-14", JORDAN, { releasedAt: "2026-11-14", settledAt: "2026-11-16", releasedBy: ELISE }),
  pay("SAMPLE-PAY-005", "AP-00424", 1, "settled", 473135, "2026-11-11", JORDAN, { releasedAt: "2026-11-11", settledAt: "2026-11-12", releasedBy: ELISE }),

  // failed, then retried and settled → attempt history
  pay("SAMPLE-PAY-006", "AP-00401", 1, "failed", 138600, "2026-11-12", SAM, { releasedAt: "2026-11-12", failedAt: "2026-11-13", failureCode: "BANK_ERROR", releasedBy: ELISE }),
  pay("SAMPLE-PAY-007", "AP-00401", 2, "settled", 138600, "2026-11-14", SAM, { releasedAt: "2026-11-14", settledAt: "2026-11-16", releasedBy: ELISE }),

  // USD: failed (currency), bank details fixed, retried and released
  {
    ...pay("SAMPLE-PAY-008", "AP-00405", 1, "failed", 195000, "2026-11-16", SAM, { releasedAt: "2026-11-16", failedAt: "2026-11-17", failureCode: "CURRENCY_NOT_SUPPORTED", releasedBy: ELISE }),
    currency: "USD",
    amountCadCents: 263367,
    fxRateToCad: "1.3506",
  },
  {
    ...pay("SAMPLE-PAY-009", "AP-00405", 2, "released", 195000, "2026-11-20", SAM, { releasedAt: "2026-11-20", releasedBy: ELISE }),
    currency: "USD",
    amountCadCents: 263367,
    fxRateToCad: "1.3506",
  },

  // released, waiting for the bank
  pay("SAMPLE-PAY-010", "AP-00398", 1, "released", 941516, "2026-11-20", JORDAN, { releasedAt: "2026-11-20", releasedBy: ELISE }),
  pay("SAMPLE-PAY-011", "AP-00419", 1, "released", 741718, "2026-11-21", SAM, { releasedAt: "2026-11-21", releasedBy: ELISE }),

  // scheduled
  // Elise approved AP-00396 and AP-00422, so she cannot release them; a Controller must.
  pay("SAMPLE-PAY-012", "AP-00396", 1, "scheduled", 92941, "2026-11-24", SAM),
  pay("SAMPLE-PAY-013", "AP-00408", 1, "scheduled", 81900, "2026-11-25", JORDAN),
  pay("SAMPLE-PAY-014", "AP-00417", 1, "scheduled", 408147, "2026-11-24", JORDAN),
  pay("SAMPLE-PAY-015", "AP-00420", 1, "scheduled", 441044, "2026-11-26", SAM),
  pay("SAMPLE-PAY-016", "AP-00422", 1, "scheduled", 1658173, "2026-11-27", JORDAN),
  // Over $100k CAD: only a Controller can release, and not Marcus (he approved it).
  pay("SAMPLE-PAY-017", "SAMPLE-AP-90001", 1, "scheduled", 12840000, "2026-11-27", JORDAN),

  // failed → "Needs attention"
  pay("SAMPLE-PAY-018", "AP-00414", 1, "failed", 254250, "2026-11-18", JORDAN, { releasedAt: "2026-11-18", failedAt: "2026-11-19", failureCode: "ACCOUNT_CLOSED", releasedBy: ELISE }),
  pay("SAMPLE-PAY-019", "AP-00415", 1, "failed", 304745, "2026-11-19", JORDAN, { releasedAt: "2026-11-19", failedAt: "2026-11-20", failureCode: "NAME_MISMATCH", releasedBy: ELISE }),
  pay("SAMPLE-PAY-020", "AP-00418", 1, "failed", 201113, "2026-11-17", JORDAN, { releasedAt: "2026-11-17", failedAt: "2026-11-18", failureCode: "FRAUD_HOLD", releasedBy: ELISE }),

  // cancelled: same vendor and invoice number as AP-00394, which is already paid
  pay("SAMPLE-PAY-021", "AP-00407", 1, "cancelled", 245719, "2026-11-13", JORDAN, { cancelReason: "Duplicate of AP-00394 (Summit Packaging Supply invoice 000804), already paid." }),
];

function inv(
  invoiceId: string,
  vendorInvoiceNumber: string,
  vendorId: string,
  vendorName: string,
  totalCents: number,
  dueDate: string,
  approvedBy: Person[],
  status: InvoiceRecord["status"],
): InvoiceRecord {
  return {
    invoiceId,
    vendorInvoiceNumber,
    vendorId,
    vendorName,
    currency: "CAD",
    totalCents,
    totalCadCents: totalCents,
    dueDate,
    approvedBy,
    status,
  };
}

function pay(
  paymentId: string,
  invoiceId: string,
  attemptNo: number,
  status: PaymentRecord["status"],
  amountCents: number,
  scheduledDate: string,
  preparedBy: Person,
  rest: Partial<PaymentRecord> = {},
): PaymentRecord {
  return {
    paymentId,
    invoiceId,
    attemptNo,
    status,
    method: "EFT",
    currency: "CAD",
    amountCents,
    amountCadCents: amountCents,
    fxRateToCad: "1",
    scheduledDate,
    releasedAt: null,
    settledAt: null,
    failedAt: null,
    failureCode: null,
    cancelReason: null,
    preparedBy,
    releasedBy: null,
    ...rest,
  };
}
