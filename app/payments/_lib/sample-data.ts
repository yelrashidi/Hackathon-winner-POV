// ---------------------------------------------------------------------------
// TEMP: SAMPLE DATA — NOT REAL PAYMENTS.
// Vendors, people, requesters, invoice numbers and amounts come from brim_ap_dataset, but the
// payment statuses, dates, failures, flags and retries are made up for the dashboard demo.
// Bank last-4 digits are real (vendors.csv); vendors with no bank details there get "".
// SAMPLE-AP-90001 is fully invented (the dataset has no invoice over $100k CAD).
// Delete this file when getPayments() switches to the format in docs/payment-data.md.
// ---------------------------------------------------------------------------

import { failureFor } from "./failure-reasons";
import type { InvoiceRecord, PaymentFlag, PaymentRecord, Person } from "./types";

// Finance team
const PRIYA: Person = { userId: "U001", name: "Priya Raman" }; // controller (CFO)
const MARCUS: Person = { userId: "U002", name: "Marcus Webb" }; // controller
const ELISE: Person = { userId: "U003", name: "Elise Tremblay" }; // finance manager
const JORDAN: Person = { userId: "U004", name: "Jordan Okafor" }; // AP clerk
const SAM: Person = { userId: "U005", name: "Sam Patel" }; // AP clerk
// Approvers
const DEV: Person = { userId: "U007", name: "Dev Malhotra" };
const CHLOE: Person = { userId: "U008", name: "Chloe Bergeron" };
const WEN: Person = { userId: "U010", name: "Wen Zhao" };
const GRACE: Person = { userId: "U011", name: "Grace Mbeki" };
const LIAM: Person = { userId: "U012", name: "Liam O'Connor" };
// Requesters (invoices.csv → requester_user_id)
const FARID: Person = { userId: "U014", name: "Farid Fraser" };
const WYATT_M: Person = { userId: "U016", name: "Wyatt Mitchell" };
const CAMILLE_D: Person = { userId: "U017", name: "Camille Dubois" };
const STEFAN: Person = { userId: "U019", name: "Stefan Haddad" };
const MEI: Person = { userId: "U020", name: "Mei Walker" };
const BEN: Person = { userId: "U021", name: "Ben Sokolov" };
const NOAH: Person = { userId: "U022", name: "Noah Kowalski" };
const CAMILLE_C: Person = { userId: "U030", name: "Camille Campbell" };
const WYATT_L: Person = { userId: "U033", name: "Wyatt Lavoie" };
const WYATT_B: Person = { userId: "U035", name: "Wyatt Bhatt" };
const OLIVIA: Person = { userId: "U036", name: "Olivia Singh" };
const KAVYA: Person = { userId: "U037", name: "Kavya Morrison" };
const YARA: Person = { userId: "U039", name: "Yara Bouchard" };
const ELENA: Person = { userId: "U040", name: "Elena Hussain" };

// Last 4 digits of each vendor's bank account, from vendors.csv.
const BANK_LAST4: Record<string, string> = {
  V002: "8577", V003: "7293", V004: "9679", V005: "2930", V006: "7438", V008: "2597", V011: "8394",
  V012: "6574", V014: "6655", V019: "8068", V020: "0345", V027: "7687", V030: "9249", V040: "1807",
  V045: "5688", V048: "6829",
};

export const SAMPLE_INVOICES: InvoiceRecord[] = [
  inv("AP-00394", "000804", "V011", "Summit Packaging Supply", 245719, "2026-11-16", STEFAN, [DEV], "Paid"),
  inv("AP-00407", "000804", "V011", "Summit Packaging Supply", 245719, "2026-11-16", STEFAN, [DEV], "Approved"),
  inv("AP-00396", "FA-000554", "V027", "Beaumont Rivière S.E.N.C.R.L.", 92941, "2026-11-24", ELENA, [PRIYA, ELISE], "PaymentScheduled"),
  inv("AP-00398", "KE26-1196", "V012", "Keystone Racking Systems", 941516, "2026-11-20", STEFAN, [DEV], "PaymentScheduled"),
  inv("AP-00399", "FA-000315", "V020", "Quillpad Documents Ltd.", 48300, "2026-11-13", CAMILLE_C, [MARCUS], "Paid"),
  inv("AP-00401", "554", "V019", "Lattice Ledger Systems", 138600, "2026-11-17", CAMILLE_C, [MARCUS], "Paid"),
  {
    ...inv("AP-00405", "FA-002337", "V018", "Sparkgrid CRM Inc.", 195000, "2026-11-20", NOAH, [CHLOE], "PaymentScheduled"),
    currency: "USD",
    totalCadCents: 263367,
  },
  inv("AP-00408", "PI26-2805", "V017", "Pinecone Collaboration Ltd.", 81900, "2026-11-26", WYATT_L, [WEN], "PaymentScheduled"),
  inv("AP-00411", "INV-01567", "V015", "Cloudbarn Software Inc.", 252000, "2026-11-14", WYATT_L, [WEN], "Paid"),
  inv("AP-00414", "INV-00732", "V045", "ClearView Janitorial", 254250, "2026-11-19", KAVYA, [LIAM], "Approved"),
  inv("AP-00415", "GR26-2267", "V002", "Great Lakes Carriers Inc.", 304745, "2026-11-20", CAMILLE_D, [DEV], "Approved"),
  inv("AP-00417", "FA-002393", "V005", "Laurentian Logistics Inc.", 408147, "2026-11-25", BEN, [DEV], "PaymentScheduled"),
  inv("AP-00418", "INV-03017", "V040", "Lakeshore Hydro Services", 201113, "2026-11-18", YARA, [LIAM], "Approved"),
  inv("AP-00419", "FA-000790", "V048", "Talentbridge Recruiting", 741718, "2026-11-21", WYATT_B, [GRACE], "Approved"),
  inv("AP-00420", "FA-001617", "V003", "Prairie Express Haulage", 441044, "2026-11-27", MEI, [DEV], "PaymentScheduled"),
  inv("AP-00421", "850", "V014", "Hardhat Outfitters Ltd.", 687811, "2026-11-16", FARID, [DEV], "Paid"),
  inv("AP-00422", "FA-000793", "V048", "Talentbridge Recruiting", 1658173, "2026-11-28", OLIVIA, [GRACE, ELISE], "PaymentScheduled"),
  inv("AP-00424", "FA-001681", "V008", "Redline Fleet Cards Inc.", 473135, "2026-11-12", WYATT_M, [DEV], "Paid"),
  inv("SAMPLE-AP-90001", "INV-SAMPLE-01", "V030", "Brightmore Consulting Group", 12840000, "2026-11-30", BEN, [DEV, ELISE, MARCUS], "PaymentScheduled"),
  // Approved, no payment scheduled yet → "To schedule".
  inv("AP-00425", "000638", "V006", "Northbound Couriers", 371634, "2026-11-23", CAMILLE_D, [DEV], "Approved"),
  inv("AP-00426", "1619", "V004", "Cascadia Cartage Ltd.", 256392, "2026-11-23", CAMILLE_D, [DEV], "Approved"),
];

export const SAMPLE_PAYMENTS: PaymentRecord[] = [
  // settled
  pay("SAMPLE-PAY-001", "AP-00394", 1, "settled", 245719, "2026-11-13", SAM, { releasedAt: "2026-11-13", settledAt: "2026-11-14", releasedBy: ELISE }),
  pay("SAMPLE-PAY-002", "AP-00399", 1, "settled", 48300, "2026-11-12", SAM, { releasedAt: "2026-11-12", settledAt: "2026-11-13", releasedBy: ELISE }),
  pay("SAMPLE-PAY-003", "AP-00411", 1, "settled", 252000, "2026-11-13", JORDAN, { releasedAt: "2026-11-13", settledAt: "2026-11-14", releasedBy: ELISE }),
  pay("SAMPLE-PAY-004", "AP-00421", 1, "settled", 687811, "2026-11-14", JORDAN, { releasedAt: "2026-11-14", settledAt: "2026-11-16", releasedBy: ELISE }),
  pay("SAMPLE-PAY-005", "AP-00424", 1, "settled", 473135, "2026-11-11", JORDAN, { releasedAt: "2026-11-11", settledAt: "2026-11-12", releasedBy: ELISE }),

  // failed, then retried and settled → attempt history
  pay("SAMPLE-PAY-006", "AP-00401", 1, "failed", 138600, "2026-11-12", SAM, { releasedAt: "2026-11-12", failedAt: "2026-11-13", failure: failureFor("BANK_ERROR"), releasedBy: ELISE }),
  pay("SAMPLE-PAY-007", "AP-00401", 2, "settled", 138600, "2026-11-14", SAM, { releasedAt: "2026-11-14", settledAt: "2026-11-16", releasedBy: ELISE }),

  // USD: failed (currency), bank details fixed, retried and released
  {
    ...pay("SAMPLE-PAY-008", "AP-00405", 1, "failed", 195000, "2026-11-16", SAM, { releasedAt: "2026-11-16", failedAt: "2026-11-17", failure: failureFor("CURRENCY_NOT_SUPPORTED"), releasedBy: ELISE }),
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

  // scheduled → release queue
  // Priya and Elise approved AP-00396, so neither can release it; Marcus can.
  pay("SAMPLE-PAY-012", "AP-00396", 1, "scheduled", 92941, "2026-11-24", SAM),
  pay("SAMPLE-PAY-013", "AP-00408", 1, "scheduled", 81900, "2026-11-25", JORDAN),
  // Elise scheduled this one herself, so she cannot also release it.
  pay("SAMPLE-PAY-014", "AP-00417", 1, "scheduled", 408147, "2026-11-24", ELISE),
  pay("SAMPLE-PAY-015", "AP-00420", 1, "scheduled", 441044, "2026-11-26", SAM),
  // Over $100k CAD: only a Controller can release, and not Marcus (he approved it).
  pay("SAMPLE-PAY-017", "SAMPLE-AP-90001", 1, "scheduled", 12840000, "2026-11-27", JORDAN),

  // failed → "Needs attention"
  // Talentbridge's account is closed: this payment failed and raised a High flag on the supplier.
  pay("SAMPLE-PAY-011", "AP-00419", 1, "failed", 741718, "2026-11-20", SAM, { releasedAt: "2026-11-20", failedAt: "2026-11-21", failure: failureFor("ACCOUNT_CLOSED"), releasedBy: ELISE }),
  // Talentbridge's other payment: scheduled, but its open High flag (account closed) blocks release.
  pay("SAMPLE-PAY-016", "AP-00422", 1, "scheduled", 1658173, "2026-11-27", JORDAN),
  pay("SAMPLE-PAY-018", "AP-00414", 1, "failed", 254250, "2026-11-18", JORDAN, { releasedAt: "2026-11-18", failedAt: "2026-11-19", failure: failureFor("INVALID_ACCOUNT"), releasedBy: ELISE }),
  pay("SAMPLE-PAY-019", "AP-00415", 1, "failed", 304745, "2026-11-19", JORDAN, { releasedAt: "2026-11-19", failedAt: "2026-11-20", failure: failureFor("NAME_MISMATCH"), releasedBy: ELISE }),
  pay("SAMPLE-PAY-020", "AP-00418", 1, "failed", 201113, "2026-11-17", JORDAN, { releasedAt: "2026-11-17", failedAt: "2026-11-18", failure: failureFor("FRAUD_HOLD"), releasedBy: ELISE }),

  // cancelled: same vendor and invoice number as AP-00394, which is already paid
  pay("SAMPLE-PAY-021", "AP-00407", 1, "cancelled", 245719, "2026-11-13", JORDAN, { cancelReason: "Duplicate of AP-00394 (Summit Packaging Supply invoice 000804), already paid." }),
];

// Flags raised by the sample failures, per the urgency rules in docs/payment-data.md.
export const SAMPLE_FLAGS: PaymentFlag[] = [
  flag("SAMPLE-FLAG-001", "low", "BANK_ERROR", "payment", "V019", "SAMPLE-PAY-006", "2026-11-13T10:00:00-05:00",
    "Last attempt failed: Bank error. Retry when ready.",
    { clearedAt: "2026-11-14T09:00:00-05:00", clearedAutomatically: true }),
  flag("SAMPLE-FLAG-002", "high", "CURRENCY_NOT_SUPPORTED", "supplier", "V018", "SAMPLE-PAY-008", "2026-11-17T10:00:00-05:00",
    "Review: a payment to this supplier failed (Currency not supported) on 2026-11-17.",
    { clearedAt: "2026-11-19T15:30:00-05:00", clearedAutomatically: true }),
  flag("SAMPLE-FLAG-003", "critical", "FRAUD_HOLD", "supplier", "V040", "SAMPLE-PAY-020", "2026-11-18T11:20:00-05:00",
    "Stopped: fraud hold on this supplier. Controller must review."),
  flag("SAMPLE-FLAG-004", "high", "INVALID_ACCOUNT", "supplier", "V045", "SAMPLE-PAY-018", "2026-11-19T10:05:00-05:00",
    "Review: a payment to this supplier failed (Invalid account) on 2026-11-19."),
  flag("SAMPLE-FLAG-005", "high", "NAME_MISMATCH", "supplier", "V002", "SAMPLE-PAY-019", "2026-11-20T09:40:00-05:00",
    "Review: a payment to this supplier failed (Name mismatch) on 2026-11-20."),
  flag("SAMPLE-FLAG-006", "high", "ACCOUNT_CLOSED", "supplier", "V048", "SAMPLE-PAY-011", "2026-11-21T08:30:00-05:00",
    "Review: a payment to this supplier failed (Account closed) on 2026-11-21."),
];

function vendorOf(invoiceId: string): string {
  return SAMPLE_INVOICES.find((i) => i.invoiceId === invoiceId)?.vendorId ?? "";
}

function flag(
  flagId: string,
  urgency: PaymentFlag["urgency"],
  reasonCode: PaymentFlag["reasonCode"],
  scope: PaymentFlag["scope"],
  vendorId: string,
  paymentId: string,
  createdAt: string,
  message: string,
  cleared: Partial<PaymentFlag> = {},
): PaymentFlag {
  return {
    flagId, urgency, reasonCode, message, scope, vendorId, paymentId, createdAt,
    clearedBy: null, clearedAt: null, clearNote: null, clearedAutomatically: false,
    ...cleared,
  };
}

function inv(
  invoiceId: string,
  vendorInvoiceNumber: string,
  vendorId: string,
  vendorName: string,
  totalCents: number,
  dueDate: string,
  requestedBy: Person,
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
    requestedBy,
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
    failure: null,
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
    holdReason: null,
    preparedBy,
    releasedBy: null,
    flags: [], // filled in by getPayments() from SAMPLE_FLAGS
    ...rest,
    bankAccount: { vendorId: vendorOf(invoiceId), version: 1, last4: BANK_LAST4[vendorOf(invoiceId)] ?? "" },
  };
}
