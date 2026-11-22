# Bonus — Journal export (approved bills + payments → the accounting system)

**Owner:** Youssef · **Code as of:** `journal-export` (on main `3161846`)

## What it does
The brief's bonus *"Export approved invoices and payments as a journal for an accounting system."*
The **Journal export** page (Records → Journal export, `/journal`) turns approved bills and settled
payments into balanced journal entries and downloads them as one CSV that QuickBooks / Xero / Sage
import, so nobody retypes them. Each download is recorded, and those entries then count as posted.

## Who
`authorize("journal.export")`: **Finance Manager and Controller/Admin** — the people who own the
books decide what is posted and when (team decision 2026-11-21). Clerk, Operations Manager and
Auditor get "not for your role" on the page and 403 on the download; refusals are audited.

## The entries (`src/server/features/journal/build.ts`, pure)
| Entry | Dated | Lines |
|---|---|---|
| **Bill** — status Approved, PaymentScheduled or Paid | invoice date | Dr each coded line's account + department · Dr 1160/1165 recoverable tax · Dr goods lines' share of non-recoverable tax (BC PST) · **Cr 2100 Accounts Payable** |
| **Payment** — status **settled** only | paid date (or settled date) | **Dr 2100** what it clears (at the bill's rate) · Cr bank (EFT, cheque) or Brim card payable (card) · Cr purchase discounts (early-pay discount taken) · Dr/Cr 7020 FX gain/loss (rate moved) |

- The bill side **is coding's own journal** (`buildJournal`), the one the clerk saw on Checks.
- All amounts are **integer CAD cents** (the books' currency). USD lines are converted at the
  invoice-date rate with exact decimal maths (`toCad`, no floats) and pinned to the stored CAD total;
  the original amount and rate stay on every line.
- **Every entry balances by construction**; a bill whose own journal does not balance, has an
  uncoded line or no CAD total is **left out with the reason** ("Can't be posted"), never half-exported.
- Only **settled** payments: a released transfer can still fail, so posting only confirmed payments
  means nothing ever has to be reversed.

## Mapped accounts (`config.ts`)
Harborline's chart of accounts has no bank, card or discount account, so payments credit mapped
accounts the page displays: **1010 Cash – operating**, **2150 Brim card payable**, **4910 Purchase
discounts**. Override with `JOURNAL_BANK_ACCOUNT`, `JOURNAL_CARD_ACCOUNT`, `JOURNAL_DISCOUNT_ACCOUNT`.

## Never posted twice
`exportJournal` writes one `journal.exported` audit event (inside an advisory lock) listing every bill
and payment id it contained. "Only entries not exported before" (the default) skips those, so a late
approval dated last month is picked up by the next export instead of being missed or doubled. Untick
it to re-download a period. The page shows the export history.

## The file
CSV, one row per line: `entry_id, entry_date, entry_type, invoice_id, payment_id, vendor_id,
vendor_name, reference, gl_account, account_name, department, description, debit_cad, credit_cad,
currency, amount_original, fx_rate`. Entry ids are stable (`JE-BILL-<invoice>`, `JE-PAY-<payment>`)
so an accounting system can de-duplicate too. Cells are formula-neutralised like the audit export.

## Bad input
Uncoded line / unbalanced coding / no CAD total → left out with the reason. Credit note → the mirror
image (expenses credited, AP debited). USD paid at a different rate → the difference to 7020.
Instalments → one payment entry each.

## At 100× volume
One query per table per export, entries built in memory (all of history: ~800 entries, < 50 ms).
At 100× page the preview and stream the CSV; store exported ids in their own table instead of
audit metadata.

## Known gaps
Mapped accounts are config, not an Admin screen. Payment reversals (a settled payment refunded) are
not modelled (none in the data). Tests: `src/server/features/journal/__tests__/journal.test.ts`.
