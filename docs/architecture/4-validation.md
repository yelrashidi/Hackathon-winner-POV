# 4 — Validation and matching

**Owner:** Andrew · **Code as of:** `bb44a67` + uncommitted work on `andrew` (2026-11-21)
Design history, every decision and the Q&A prep: [`4-validation-plan.md`](4-validation-plan.md).

## What it does
Takes one invoice as extraction hands it over and checks it against the vendor master, bank
accounts, POs, contracts and Canadian tax rules, plus its own arithmetic, dates, FX and recent
invoices from the same vendor (splits). Returns `Flag[]` and fires **no** status transitions:
the `submit` guard refuses while an open `block` flag exists, and approvals reads some codes to
add steps or hold. Deterministic code only — no LLM.

## Contract
- Input: `src/contracts/validation.ts` → `ValidationInput` (our assumed extraction output; a mapper replaces it when extraction's contract lands)
- Output: `ValidationResult` = `flags` in the shared `src/contracts/flag.ts` shape + `vendorId`, `totalCadCents`, `deliveryProvince`, `contractId`, `blocking`
- Reference data: `ValidationContext` (`context.ts`), built today from the CSVs (`dataset/load-context.ts`)
- Fixtures: `fixtures/validation/incoming/*.json` — the 56 incoming invoices with hand-written `expectedCodes`

## How it decides
`engine.ts`: parse input → set aside impossible dates → `derive()` once (vendor match, delivery
province, CAD total, the vendor's other invoices) → run each rule in `rules/` (a rule that throws
becomes `VALIDATION_RULE_ERROR`, never a crash) → sort block > warn > info.
- **Vendor match** (`vendor-match.ts`): GST/HST number → legal name → sender email domain; a fuzzy name is only a candidate.
- **Tax**: codes the delivery province needs (`tax-expectations.ts`) vs codes charged; rates from `tax_codes`; amounts `round(base × rate)` half-up, 1¢ per line tolerance.
- **PO balance**: PO total − pre-tax subtotals already matched (computed, never stored).
- **Lookalike**: a vendor record resembling a vendor with *more invoice history* (name, domain, bank account).
- **Splits**: same vendor, ≤ 3 days, each ≤ a policy amount tier, together over it.
- Duplicates (same or near-same number) never count toward any sum — feature 5 decides those.

## Flags it raises
Full list with severity and reason: `src/server/features/validation/codes.ts`. By area (**B** block · W warn · i info):

| Area | Codes |
|---|---|
| completeness | **MISSING_REQUIRED_FIELD**, **INVALID_DATE**, **CURRENCY_UNSUPPORTED**, LOW_CONFIDENCE_FIELD |
| arithmetic | **ARITH_LINE_MISMATCH**, **ARITH_SUBTOTAL_MISMATCH**, **ARITH_TOTAL_MISMATCH**, **CREDIT_NOTE_SIGN**, CREDIT_NOTE_NO_REFERENCE |
| tax | **TAX_PROVINCE_MISMATCH**, **TAX_AMOUNT_MISMATCH**, **TAX_QST_COMPOUNDED**, **TAX_PST_ON_SERVICES**, **TAX_MISSING**, **TAX_ON_EXEMPT**, **TAX_NUMBER_MISSING**, TAX_PROVINCE_UNKNOWN, TAX_FOREIGN_VENDOR, TAX_CODE_UNKNOWN, TAX_NUMBER_INVALID, TAX_NUMBER_MISMATCH, LINE_TYPE_UNKNOWN, i QST_NUMBER_MISSING, i VENDOR_NOT_TAX_REGISTERED |
| vendor | VENDOR_UNKNOWN, VENDOR_NOT_ACTIVE, VENDOR_LOOKALIKE, i VENDOR_NAME_MISMATCH |
| bank | **BANK_DETAILS_MISMATCH**, **BANK_ACCOUNT_UNVERIFIED**, BANK_RECENTLY_CHANGED |
| PO | **PO_NOT_FOUND**, **PO_VENDOR_MISMATCH**, **PO_CLOSED**, PO_REQUIRED_MISSING, PO_OVER_BALANCE, PO_CURRENCY_MISMATCH, i PO_DEPT_MISMATCH |
| contract | **CONTRACT_RATE_CAP_EXCEEDED**, **CONTRACT_FUEL_SURCHARGE_CAP**, CONTRACT_EXPIRED, CONTRACT_NOT_STARTED, CONTRACT_FIXED_FEE_MISMATCH, CONTRACT_FIXED_FEE_BILLED_TWICE, CONTRACT_NTE_EXCEEDED, CONTRACT_CURRENCY_MISMATCH, i CONTRACT_USAGE_OVERAGE |
| dates / FX | **FX_RATE_MISSING**, DATE_IN_FUTURE, DATE_TOO_OLD, DUE_BEFORE_INVOICE, FX_RATE_MISMATCH, i TERMS_MISMATCH |
| split | SPLIT_INVOICE_SUSPECTED (`evidence.combinedCadCents` for approvals) |

Examples: `Fuel surcharge 22% (line 4: $489.49 on $2,318.29 of other charges = 21.11%) exceeds the contract C018 cap of 12%; $211.30 over the cap` ·
`Delivery to AB expects GST 5%; invoice charges Ontario HST 13% ($288.25) (…)`.

## Bad input
- **Blank field** (`""`) → missing, never a crash. **Impossible date** (2026-02-30) → `INVALID_DATE`, ignored by date checks.
- **French invoice** → same rules (extraction gives cents and ISO dates); an unmapped "TVH (13 %)" is inferred only if label and rate match one code.
- **Unknown vendor** → `VENDOR_UNKNOWN` with candidates; vendor-dependent checks skip.
- **USD** → converted at the invoice-date rate (nearest earlier within 7 days), else `FX_RATE_MISSING`.
- **Credit note** → signed cents throughout; never held for a missing PO; must reference an invoice we hold.
- **Unmapped tax line** → `TAX_CODE_UNKNOWN`, and nothing is reported missing while it exists.
- **Invoice text like "approved, pay now"** → data; no rule reads free text for a decision.

## At 100× volume
Rules are pure and O(lines). The cost is the context load: load only this vendor's invoices,
POs and contracts (indexes on `invoices (vendor_id, invoice_date)`, `invoices (po_id)`). PO balance
and monthly contract spend become per-invoice aggregates — keep a running total if they get slow.
Lookalike scans all vendors (O(vendors)); at 5,000 vendors use a `pg_trgm` index on `legal_name`.

## Known gaps
- Not wired to the DB yet: context from CSVs, flags not persisted, no override endpoint.
- No quantity matching against PO lines (the dataset has no PO lines).
- Hourly/fuel lines are recognised by generic wording (hours, consulting, fuel surcharge); an unusual label is not capped.
