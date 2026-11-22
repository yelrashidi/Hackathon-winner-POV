# 5 — Duplicates

**Owner:** Arpan · **Code as of:** `cfde335` + uncommitted on `arpan/feature/duplicate-check` (2026-11-21)

## What it does
Runs inside the analysis pass, right after validation has worked out the vendor and the CAD total
(`src/server/pipeline/ingest.ts`, `analyse()`). It compares the invoice with the copies already on
record and with Brim card charges, and raises flags with the related invoice or card charge attached.
**It never decides.** Every flag goes to the duplicates dashboard (`/payments/duplicates`), where an
AP clerk or controller either confirms it (`confirmDuplicate` → `Voided`, or `confirmPaidByCard` →
`Closed`, through `fire()`) or dismisses it as "not a duplicate" (the flag is overridden with a note).
Nothing is deleted: both copies stay in the audit trail.

## Contract
- Input: the stored invoice row (vendor and CAD total come from validation), `InvoiceOnRecord` in `src/server/features/duplicates/context.ts`
- Output: shared `Flag` (`src/contracts/flag.ts`), persisted to `invoice_flags` with `source = 'duplicates'` through validation's `syncFlags`
- Audit: `invoice.duplicates_checked` (new, additive, in `src/contracts/audit.ts`), plus `flag.*` and `invoice.status_changed`

## How it decides: no full scan, a few indexed lookups
The rules are fixed. What would be slow is comparing every invoice with every other one, and we
don't do that. For one invoice, `db/load-context.ts` loads:
- this vendor's invoices (`invoices_vendor_number_idx`) and any invoice with the same file sha256 (`documents_sha256_idx`)
- card charges with the same amount inside ±45 days of the invoice date
- vendor names, only when a card charge needs its merchant matched

Then `engine.ts` (pure, no I/O) compares the invoice with that small set:

- **Only the second copy is flagged.** An earlier invoice is "the original": earlier received date, then created time, then id. A pair raises one flag, on the copy a person would void.
- **Invoice numbers are compared in canonical form** (`numbers.ts`): upper case, letters and digits only, leading zeros dropped. So `ST-4471` = `st 4471` and `000604` = `604`. A *variant* is a short prefix or suffix (`000903-A`) or the same digits (`FA-001655` vs `1655-A`). A variant needs the same amount or date as well, because sequential numbers (`INV-01536` / `-37`) must never match.
- **Card merchant → vendor by name** (`merchant.ts`): the descriptor is cut at about 22 characters, so it must be the *start* of exactly one vendor's name (`VOYAGEUR CORPORATE TRA` → Voyageur Corporate Travel). Otherwise trigram similarity ≥ 0.6 with a single clear winner. It uses the same name normalization as validation's `matchVendor`. AP's own `ap_virtual_card` charges are skipped, because they pay an invoice that is already on record.
- Credit notes are compared only with credit notes. Voided or rejected invoices are ignored.

## Flags it raises (`codes.ts`)
| Code | Severity | Fires when | Message example |
|---|---|---|---|
| `DUPLICATE_DOCUMENT` | block | same file sha256 | The same file was already received as invoice … |
| `DUPLICATE_INVOICE` | block | same vendor + same canonical number (any date or amount) | Invoice number 001468 from this vendor is already on record as AP-00389 (… $16,131.94, paid). This one: … dated 2026-10-06 … The date differs. |
| `DUPLICATE_NUMBER_VARIANT` | block | same vendor, variant number, same amount or date | Invoice number 000903-A looks like a re-issue of 000903 — AP-00277 … with the same amount. |
| `DUPLICATE_SUSPECTED` | warn | same vendor, other number, same amount, ≤ 7 days apart | Same vendor and same amount $2,520.00 1 day apart as AP-00411 … |
| `SPLIT_IF_NOT_DUPLICATE` | warn | with a same-number duplicate: within 3 days, each at or under an approval limit, together over it | If this is NOT a duplicate of AP-00277, the two bills together are $11,148.74 CAD within 2 days: over the $10,000.00 approval limit… |
| `ALREADY_PAID_BY_CARD` | block | employee-card charge at this vendor, same amount, ±45 days | Card charge CT-00324 at "ALPENGLOW EVENTS & CAT" for $2,511.36 … |

Each flag carries `evidence.field = related:<invoiceId>` or `card:<txnId>`, so it has the same
identity on every re-run. A dismissed "not a duplicate of X" stays dismissed, and a new match Y is a new flag.

## Duplicate and split: both facts, a person decides
Validation's split check (`SPLIT_INVOICE_SUSPECTED`, `validation/rules/split.ts`) leaves same or
near-same numbers out of its sums, so it stays silent on duplicate pairs. The team decided on
2026-11-21 to show both facts anyway, because a person makes the final call. So for those pairs this
feature raises `SPLIT_IF_NOT_DUPLICATE`, using the same approval limits (`approvalThresholdsFromPolicyRows`)
and the same 3-day window. On the dashboard, the split fact is shown on the duplicate's card, along
with any open validation split flag on that invoice, not as a card of its own.
- Confirm the duplicate → both flags are resolved.
- "Not a duplicate" → the split fact stays on the invoice as an open warning.

## On the dataset (`npm run duplicates:batch`)
- **Incoming 56:** 5 flagged; `000961` and `000903-A` also carry a split fact (both together > $10,000). The 3 that validation's fixtures leave to feature 5 (`INV-01561` with the date moved a month, `001468`, `000903-A`), plus `583` vs paid `FA-000583` and `000961` received twice.
- **History 426:** the 6 same-number pairs, `1655-A` vs `FA-001655`, and the **live pair AP-00394 / AP-00407** (`000804`, both scheduled), flagged on AP-00407. Also 7 employee-card charges that match invoices exactly. **No false positives from monthly fixed fees** (20+ vendors bill the same amount every month). That is why the "suspected" window is 7 days, not 30.

## Bad input
- **Unknown vendor** (validation could not match it): only `DUPLICATE_DOCUMENT` (same file) can fire. Number and card checks need a vendor, so they stay silent rather than guess.
- **Missing number, date or total:** the checks that need that field skip it. No flag is raised on missing data; validation already flags missing fields.
- **Scan misread** (`0OO804`): not matched as the same number. An OCR-tolerant comparison is a gap; the "same amount within 7 days" warning often catches it anyway.
- **USD:** amounts are compared in the invoice currency, or in CAD for card charges. CAD comes from validation's rate for the invoice date.
- **Credit note:** compared only with credit notes, never against the invoice it credits.
- **Impossible date** (`2026-02-30`): treated as unknown, never computed with.

## At 100× volume
Per invoice: a vendor-scoped indexed query, a sha256 lookup, and an amount + date card query. That
cost doesn't grow with the size of the history. Next steps would be: an index on
`card_transactions (amount_cad_cents, posted_date)`; write `card_transactions.vendor_id` once when
the card feed is imported, instead of matching names on each check; and store
`invoice_number_norm` in the canonical form (leading zeros dropped) so a variant search can use an index.

## Known gaps
- **The state machine has no void after approval.** A duplicate found on an invoice that is already `PendingApproval` or later (AP-00407 is `PaymentScheduled`) can only be dismissed on the dashboard. Its open block flag should stop release, but payments still reads flags from memory (`features/payments/deps.ts`). TODO P0 "hold at release time".
- A re-check at release time (`checkDuplicatesAndPersist`) exists but nothing calls it yet. It's for payments (Katie).
- After "not a duplicate", approvals still routes on the single invoice: it reads only validation's `SPLIT_INVOICE_SUSPECTED.combinedCadCents`, not `SPLIT_IF_NOT_DUPLICATE`. If that pair should be routed on the combined total, approvals (Youssef) has to read this code as well.
