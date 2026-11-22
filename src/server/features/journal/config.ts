/**
 * Accounts the journal needs that Harborline's chart of accounts (gl_accounts.csv) does not have.
 * The dataset's chart has no bank account, no Brim card account and no purchase-discount account,
 * so payment entries credit these MAPPED accounts. Change them here (or with the environment
 * variables) to whatever the accounting system the file is imported into uses; the export page
 * shows the mapping so nobody imports a file blind.
 *
 * Everything else comes from the data: expense accounts and departments from each coded line,
 * tax accounts (1160 / 1165) from tax_codes, Accounts Payable (2100) and FX gain/loss (7020) from
 * gl_accounts.
 */
export interface MappedAccount {
  code: string;
  name: string;
}

// Read once when the module loads; an unset or blank variable keeps the default account.
const env = (key: string, fallback: string) => process.env[key]?.trim() || fallback;

export const JOURNAL_ACCOUNTS = {
  /** EFT and cheque payments leave the operating bank account. */
  bank: { code: env("JOURNAL_BANK_ACCOUNT", "1010"), name: "Cash – operating account (mapped)" },
  /** A bill paid with a Brim virtual card moves the debt from the supplier to the card. */
  card: { code: env("JOURNAL_CARD_ACCOUNT", "2150"), name: "Brim card payable (mapped)" },
  /** An early-payment discount taken: paid less than the bill, the difference is income. */
  discount: { code: env("JOURNAL_DISCOUNT_ACCOUNT", "4910"), name: "Purchase discounts taken (mapped)" },
} satisfies Record<string, MappedAccount>;

/** In the chart of accounts: used when a USD payment's CAD amount differs from the bill's. */
export const FX_GAIN_LOSS_ACCOUNT = "7020";

/** Bills enter the journal once approved; these statuses mean "approved to pay". */
export const POSTED_BILL_STATUSES = ["Approved", "PaymentScheduled", "Paid"];
