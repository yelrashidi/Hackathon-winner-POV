# 4 — Validation and matching: implementation plan

**Owner:** Andrew · **Status:** plan, no code yet · **Written:** 2026-11-20 against `bb44a67`
(`main`) and Youssef's `origin/Youssef` branch (`src/contracts/flag.ts`, `approvals.ts`).

When the code lands, this becomes `4-validation.md` (from `_feature-template.md`) and the plan
parts get deleted. Rules that apply to every file here: [`.claude/CLAUDE.md`](../../.claude/CLAUDE.md),
[`money-and-tax.md`](../rules/money-and-tax.md), [`backend.md`](../rules/backend.md),
[`contracts.md`](../rules/contracts.md).

---

## 0. As built (2026-11-21, on branch `andrew`, uncommitted)

The pure engine and every check are implemented and tested. It runs standalone: the input is our
assumed extraction output (`src/contracts/validation.ts` → `ValidationInput`), and reference data
comes from the dataset CSVs. Still to do once teammates land: the DB loader, persisting flags,
the override endpoint, and a mapper from extraction's real contract.

- **Code:** all in `src/server/features/validation/`. `engine.ts` (runs the rules) ·
  `rules/*.ts` (one file per area) · `codes.ts` (every code, severity, why) · `config.ts`
  (every threshold) · `vendor-match.ts`, `province.ts`, `tax-expectations.ts` · `lib/` (cents,
  dates, FX, text) · `dataset/` (CSV → context; dev only until the DB exists).
- **Contracts:** `src/contracts/flag.ts` is copied verbatim from `origin/Youssef`;
  `src/contracts/validation.ts` is new (`contract:` in the PR).
- **Run:** `npm test` (264 tests) · `npm run validate:batch` (prints every flag for the 56
  incoming invoices) · `npm run validate:history` (false-positive replay of the 426 historical invoices).
- **Evidence it works:** all 56 incoming invoices raise exactly the flags written by hand from
  the documents (`fixtures/validation/incoming/*.json` → `expectedCodes`). The history replay blocks
  only the 3 real tax errors (AP-00098, AP-00253, AP-00325). Every code has a firing case and a
  near-miss case in `__tests__/cases/`.

**Changes from the plan below** (sections 2–3 are the original design):

| Item | Plan said | Built | Why |
|---|---|---|---|
| `TAX_PST_ON_SERVICES` | warn | **block** | the tax amount is wrong and PST isn't recoverable |
| `CONTRACT_RATE_CAP_EXCEEDED`, `CONTRACT_FUEL_SURCHARGE_CAP` | warn | **block** | billed above the contract is the headline overbilling case |
| `DUE_BEFORE_INVOICE` | block | **warn** | an odd vendor date isn't unsafe to pay |
| `DATE_IN_FUTURE` / `DATE_TOO_OLD` | vs today, 180 days | vs **received date**, **90 days** | doesn't depend on when the check runs; 180 missed Voyageur 000903-A |
| Split window | 7 days | **3 days** | history: 3 days catches every real split; 7 flags routine freight and travel |
| `TAX_NUMBER_MISSING` for QST | block | separate **`QST_NUMBER_MISSING` (info)** | 46 legitimate historical invoices from out-of-province vendors charge QST without one |
| `VENDOR_LOOKALIKE` | pg_trgm ≥ 0.8 | trigram in TS, **only vs a more established vendor** (more invoices on record); also identical domain or shared bank account | onboarding dates can't spot the copy (V052 was onboarded before V026); invoice history can |
| Contract in force | status + dates | **dates only** (status matters past the end date) | status is today's; Torque's February invoice was under a contract in force in February |
| Added | — | `CONTRACT_NOT_STARTED`, `CONTRACT_FIXED_FEE_BILLED_TWICE` (never happens in history; 8 times in the batch), `TAX_CODE_UNKNOWN`, `LINE_TYPE_UNKNOWN`, `VALIDATION_RULE_ERROR` | |
| Duplicates in sums | — | a same or near-same invoice number (`000903` vs `000903-A`) never counts toward PO balance, monthly caps or splits | that's feature 5's verdict; counting it would double the sums (PO-2026-0027 and -0044 have exact duplicate pairs) |
| Blank values | — | `""` or whitespace in any optional text field, date or tax code means **missing** (contract trims and nulls it), never a thrown error | review 2026-11-21: `invoiceNumber: ""` crashed the run |
| Impossible dates | — | `2026-02-30` raises **`INVALID_DATE` (block)**; the date is set aside before any rule runs (an invalid received date falls back to today) | review 2026-11-21: `Date.UTC` rolled it to March 2 and produced false age/terms flags |
| Unmapped tax lines | `TAX_CODE_UNKNOWN` only | code inferred only when label **and** printed rate match exactly one `tax_codes` row (`TVH (13 %)` → HST13); while any line stays unmapped, no tax is reported **missing** | review 2026-11-21: an unmapped French TVH line gave a false blocking `TAX_MISSING` |
| History expectations (§7.2) | `CONTRACT_EXPIRED` 6, `PO_OVER_BALANCE` 4 POs | **3** and **2** | only 3 C025 invoices are dated after 2026-06-30; POs 0027 and 0044 are duplicate pairs, not overruns |

---

## 1. What it does

Brief, feature 4: *"Check each invoice against the vendor master, contract and PO, and flag
discrepancies before payment. Check tax against the province of delivery and check the arithmetic."*

- **In:** one extracted (or hand-entered) invoice, plus the reference data it is checked against.
- **Out:** `Flag[]` in the shared shape from `src/contracts/flag.ts`, persisted to `invoice_flags`.
- **When:** in the analysis pass, every time the invoice enters `InReview` (first extraction,
  manual entry, any edit, a rejection back to review). Again at payment release, for the bank checks only.
- **Effect on status:** it fires no transitions itself. The `submit` guard
  (`InReview → PendingApproval [no blocking flags]`) reads its output, and approvals (6) reads
  some flag codes to add steps. Overrides go through `fire()` so they are audited.

**No LLM anywhere in validation.** Every flag is deterministic code with the numbers in the
message, so a judge can ask "why did this fire?" and get an exact answer.

---

## 2. Design

### 2.1 Pure core, thin shell

```
loadValidationContext(tx, invoice)   ← the only DB access (impure)
        │  ValidationContext: vendor, bank accounts, PO + already-invoiced sum, contract +
        │  same-month spend, tax codes, fx rate, recent invoices for split check, offices
        ▼
validateInvoice(invoice, ctx)        ← pure: no I/O, no clock (ctx.today is passed in)
        │  runs every rule in RULES, each (inv, ctx) => Flag[]
        ▼
persistFlags(tx, invoiceId, flags)   ← diff with the previous run, keep resolutions
```

Why: the rules are unit-testable with plain objects, give the same answer every time, and can
replay the 426 historical invoices in a script without a server. That also answers the Q&A
question "how do you know it works?".

### 2.2 Severity model

| Severity | Meaning | Effect |
|---|---|---|
| `block` | The invoice is wrong or unsafe to pay as it stands | `submit` refused. Cleared only by fixing the data (re-runs validation) or a Finance Manager override with a note |
| `warn` | Needs a human look, may be legitimate | Clerk can submit after acknowledging with a reason (audited). Some warns add an approval step through approvals' `open_flag` policy |
| `info` | Context for the reviewer | Shown only |

**Block versus hold.** Approvals already returns `hold` (→ `OnHold`) for an unknown or on-hold
vendor and for a missing required PO (P13, `po_required_missing`). Validation still raises flags
for those so the reviewer sees *why*, but at `warn`, not `block`. A `block` flag keeps the
invoice in `InReview` and would hide approvals' hold. **Confirm with Youssef** (section 9).

### 2.3 Flag shape (shared, not ours to change)

`{ code, severity, message, evidence, relatedInvoiceId?, relatedCardTxnId?, status }` from
`src/contracts/flag.ts` (currently on `origin/Youssef`, not yet on `main`).

- The **message** carries the numbers: `GST/HST charged $688.66 at HST 13%, but delivery to AB expects GST 5% ($264.87)`.
- **`evidence`** holds the structured version for the UI: `{ field, lineNo?, expected, actual,
  expectedCents?, actualCents?, ruleRef?, source }`, where `source` is e.g. `contract C022` or `tax_codes`.
  Field and line pointers live in evidence because the shared shape has no column for them.
- The **identity of a flag** across re-runs is `code + evidence.field + evidence.lineNo`. It's used to
  carry a resolution forward when the same problem is still present after an edit.

### 2.4 Money and tolerances (from `money-and-tax.md`)

- Everything is integer cents (`bigint` in the DB, `number` in TS, safe below 2^53). Rates are decimals from `tax_codes`.
- Expected tax is `round_half_up(base_cents × rate)` per tax line, using `core/money.ts`, never
  a validation-local helper.
- Arithmetic tolerance is **1 cent per line** (vendors round per line or per invoice). Tax tolerance is
  1 cent per contributing line.
- Limits are compared in CAD. USD converts at `fx_rates` for the invoice date, or the nearest earlier date (`core/fx.ts`).
- Credit notes are negative totals. Every rule says what it does with a negative (section 4).

### 2.5 Province of supply

Tax is checked against the **delivery** province, never the vendor's address. Resolution order:

1. `ship_to_province` captured by extraction. On the incoming PDFs this is the province in the
   *Bill to* block, which is one of Harborline's four office addresses.
2. Match the bill-to / ship-to address to an office (Toronto ON, Vancouver BC, Calgary AB,
   Montréal QC). Offices are reference data, not code constants.
3. Otherwise `province = null` → `TAX_PROVINCE_UNKNOWN` (warn). **Never guess.**
   The requester's `work_province` is shown in the message as a hint only.

---

## 3. The checks

Codes are `SCREAMING_SNAKE` and stable once a test or UI uses them. Two codes are fixed by
approvals' contract: **`PO_OVER_BALANCE`** and **`SPLIT_INVOICE_SUSPECTED`** (with
`evidence.combinedCadCents`). Do not rename them.

### A. Completeness (runs first; later rules skip what they cannot check)

| Code | Sev | Fires when | Message example |
|---|---|---|---|
| `MISSING_REQUIRED_FIELD` | block | vendor name, invoice number, invoice date, currency or total is missing after extraction / entry | `Invoice number is missing — enter it before submitting` |
| `LOW_CONFIDENCE_FIELD` | warn | extraction confidence for a money or date field is below the threshold | `Total read with 54% confidence — check against the PDF` |
| `CURRENCY_UNSUPPORTED` | block | currency is neither CAD nor USD | `Currency EUR is not supported (CAD, USD only)` |

### B. Arithmetic

| Code | Sev | Fires when | Message example |
|---|---|---|---|
| `ARITH_LINE_MISMATCH` | block | `qty × unit_price ≠ amount`, beyond 1 cent | `Line 2: 3 × $120.00 = $360.00, invoice shows $380.00` |
| `ARITH_SUBTOTAL_MISMATCH` | block | sum of line amounts ≠ subtotal, beyond 1 cent per line | `Lines add up to $5,263.09, subtotal shows $5,363.09` |
| `ARITH_TOTAL_MISMATCH` | block | subtotal + every tax amount ≠ total | `$5,263.09 + $263.15 + $524.99 = $6,051.23, total shows $6,015.23` |
| `CREDIT_NOTE_SIGN` | block | lines and total have mixed signs, or the document says "credit note" but the total is positive (or the reverse) | `Marked as credit note but total is +$1,614.21` |
| `CREDIT_NOTE_NO_REFERENCE` | warn | a credit note doesn't reference an original invoice we hold (missing, or refers to itself) | `Credit note CN-FA-000413 references itself; link it to the invoice it reverses` |

### C. Tax versus province of delivery

| Code | Sev | Fires when | Message example |
|---|---|---|---|
| `TAX_PROVINCE_UNKNOWN` | warn | the delivery province can't be resolved (section 2.5) | `Delivery province unknown — tax not checked (requester works in ON)` |
| `TAX_PROVINCE_MISMATCH` | block | the tax codes charged ≠ the codes expected for the province. ON → HST13. AB (and other GST-only provinces in the table) → GST5. BC → GST5 + PST7_BC on goods lines. QC → GST5 + QST9975. Expected sets are built from `tax_codes`, not hardcoded rates | `Delivery to AB expects GST 5%; invoice charges HST 13% ($688.66)` |
| `TAX_AMOUNT_MISMATCH` | block | the code is right but the amount differs from `round(base × rate)` beyond the tolerance | `QST should be $524.99 (9.975% of $5,263.09), invoice shows $551.30` |
| `TAX_QST_COMPOUNDED` | block | the QST amount equals QST on (subtotal + GST): the old compound method | `QST computed on subtotal + GST ($551.25); QST applies to the pre-tax amount only` |
| `TAX_PST_ON_SERVICES` | warn | BC PST charged on a `services` line | `BC PST 7% charged on services line 3 ("Consulting"); PST applies to goods only` |
| `TAX_MISSING` | block | a taxable Canadian supply with no tax at all | `No tax charged on a $2,150.00 supply delivered to ON (expects HST 13%)` |
| `TAX_ON_EXEMPT` | block | tax charged where the line is exempt (EXEMPT code, or insurance / GL 6510 per `gl_accounts` notes) | `GST charged on insurance premium (exempt supply)` |
| `TAX_FOREIGN_VENDOR` | warn | a non-CA vendor charges GST/HST, or a CA vendor uses the FOREIGN code | `US vendor charged GST $160.00; foreign vendors normally charge no Canadian tax` |
| `TAX_NUMBER_INVALID` | warn | the GST/HST number isn't 9 digits + `RT` + 4 digits, or the QST number isn't 10 digits + `TQ` + 4 digits | `GST/HST number "66908666RT01" is not a valid business number` |
| `TAX_NUMBER_MISMATCH` | warn | the tax number on the invoice ≠ the vendor master | `Invoice GST/HST 669086667RT0001 ≠ vendor master 669086676RT0001` |
| `TAX_NUMBER_MISSING` | block | tax charged without a registration number, or QST charged without a QST number | `QST $524.99 charged but no QST registration number on the invoice or vendor` |

Where a check is anchored in the brief: GST/HST/PST/QST rates and the place-of-supply rule come
from the dataset `README.md` and `tax_codes.csv`. BC PST on goods only and QST on the pre-tax
amount are stated there.

### D. Vendor master

| Code | Sev | Fires when | Message example |
|---|---|---|---|
| `VENDOR_UNKNOWN` | warn → hold via approvals | no vendor match by tax number, then exact name, then sender domain | `"Kestrel Safety Consultants" not in vendor master — onboard before approval` |
| `VENDOR_NOT_ACTIVE` | warn (`pending_review`, approvals adds P05 step) / warn → hold (`on_hold`) | the vendor's status ≠ `active` | `Vendor Great Lakes Carriers Incorporated is on hold` |
| `VENDOR_LOOKALIKE` | warn | `pg_trgm` similarity ≥ 0.8 to another vendor's legal name, or the sender domain is within edit distance 2 of a known vendor domain | `Name 93% similar to existing vendor Great Lakes Carriers Inc. — possible impersonation` |
| `VENDOR_NAME_MISMATCH` | info | the matched vendor's legal name differs from the name printed on the invoice | `Matched by tax number to "Cascadia Cartage Ltd."; invoice says "Cascadia Cartage"` |

### E. Bank details (also re-run at payment release)

| Code | Sev | Fires when | Message example |
|---|---|---|---|
| `BANK_DETAILS_MISMATCH` | block | remit-to institution / transit / account on the invoice ≠ the vendor's current **verified** `vendor_bank_accounts` row | `Remit-to account ••9679 differs from verified account ••7504` |
| `BANK_ACCOUNT_UNVERIFIED` | block | the vendor's current account version is `pending` (changed and not verified by callback) | `Bank account changed 2026-10-27 by email request, not verified by callback` |
| `BANK_RECENTLY_CHANGED` | warn | the verified account changed less than 30 days before the invoice date | `Bank account changed 12 days ago (verified by phone callback)` |

Why it is re-run at release: a bank change between approval and payment is the classic fraud.
Payments (7) calls `validateBankForRelease(vendorId, bankAccountId)` and refuses to release on a block.

### F. Purchase order (policies P12 / P13)

| Code | Sev | Fires when | Message example |
|---|---|---|---|
| `PO_REQUIRED_MISSING` | warn → hold via approvals (P13) | the vendor has `requires_po = yes` and no PO number was captured | `Torque Industrial requires a PO; none on this invoice` |
| `PO_NOT_FOUND` | block | the PO number isn't in `purchase_orders` | `PO-2026-0099 does not exist` |
| `PO_VENDOR_MISMATCH` | block | the PO belongs to a different vendor | `PO-2026-0014 is for Torque Industrial, invoice is from Fixwell` |
| `PO_CLOSED` | block | the PO status is `closed` | `PO-2026-0003 is closed` |
| `PO_OVER_BALANCE` | warn (approvals adds a finance-manager step) | invoice subtotal > PO total − already-invoiced on that PO (in CAD; the PO is in its own currency) | `Subtotal $2,222.44 exceeds PO-2026-0027 remaining balance $0.00 (PO $2,222.44, invoiced $2,222.44)` |
| `PO_DEPT_MISMATCH` | info | the PO's department ≠ the invoice's department | `PO raised by Operations, invoice coded to Facilities` |

The remaining balance is **computed, not stored** (data-model.md): `PO total − Σ subtotal of
non-voided invoices matched to the PO, excluding this invoice`. A credit note against a PO
adds balance back.

### G. Contract

One rule per billing type in `contracts.csv`. A contract is matched by `contract_id` if
extraction found one, otherwise by the vendor's active contract on the invoice date.

| Code | Sev | Fires when | Message example |
|---|---|---|---|
| `CONTRACT_EXPIRED` | warn | the invoice date is outside `start_date..end_date` and the contract wasn't renewed, or the status is `expired` | `Contract C025 ended 2026-06-30; invoice dated 2026-07-14` |
| `CONTRACT_FIXED_FEE_MISMATCH` | warn | `fixed_monthly`: base line(s) ≠ `monthly_fee` | `Monthly fee billed $2,343.50, contract C008 fixes it at $2,150.00 (+9.0%)` |
| `CONTRACT_USAGE_OVERAGE` | info | `fixed_monthly`: lines on top of the base fee (usage / overage) | `$324.23 usage overage on top of the $4,800.00 committed fee (C007)` |
| `CONTRACT_RATE_CAP_EXCEEDED` | warn | `retainer` / `rate_card` with `hourly_rate_cap`: an hourly line (qty > 1 or "hours" in the description) has unit price > cap | `Line 1: 11 h at $419.80/h — within cap $520.00` (passes) / `$610.00/h exceeds cap $520.00 (C022)` |
| `CONTRACT_FUEL_SURCHARGE_CAP` | warn | `rate_card` with `fuel_surcharge_cap_pct`: the fuel surcharge % (printed, or computed as surcharge ÷ freight lines) > cap | `Fuel surcharge 13.4% exceeds contract cap 12% (C018): $41.20 over` |
| `CONTRACT_NTE_EXCEEDED` | warn | this invoice + other non-voided invoices from the vendor in the same calendar month > `not_to_exceed_monthly` | `June spend with Harlow & Stern would reach $24,937.05, contract C022 cap is $20,000.00` |
| `CONTRACT_CURRENCY_MISMATCH` | warn | invoice currency ≠ contract currency | `Invoice in CAD, contract C002 is in USD` |

### H. Dates, FX and splits

| Code | Sev | Fires when | Message example |
|---|---|---|---|
| `DATE_IN_FUTURE` | warn | the invoice date is after `ctx.today` | `Invoice dated 2026-12-15, after today (2026-11-20)` |
| `DATE_TOO_OLD` | warn | the invoice date is more than 180 days before `ctx.today` | `Invoice dated 2026-03-02, 263 days ago` |
| `DUE_BEFORE_INVOICE` | block | the due date is before the invoice date | `Due 2026-10-01 is before the invoice date 2026-10-27` |
| `TERMS_MISMATCH` | info | due date ≠ invoice date + vendor `payment_terms_days` (± 1 day) | `Due in 15 days; vendor terms are Net 30` |
| `FX_RATE_MISMATCH` | warn | USD invoice whose stated or applied rate differs from `fx_rates` by more than 0.5% | `Rate 1.4100 used, fx_rates rate for 2026-10-21 is 1.3780` |
| `SPLIT_INVOICE_SUSPECTED` | warn (approvals routes on `evidence.combinedCadCents`) | 2+ invoices from the same vendor (any requester) within 7 days, each under an approval threshold (10k / 50k / 250k CAD, read from the policies, not hardcoded), whose combined CAD total crosses it | `With INV-1041 and INV-1042 (3 days apart), combined $14,820.00 crosses the $10,000 dept-manager limit` |

Splits overlap with duplicates (5). The difference: duplicates are *the same bill twice*,
splits are *different bills to dodge a limit*. **Agree with the duplicates owner** that a
pair flagged as a duplicate is not also flagged as a split.

---

## 4. Bad input

| Input | What happens |
|---|---|
| Missing fields after extraction | `MISSING_REQUIRED_FIELD`; rules that need the field skip themselves (no cascade of nonsense flags) |
| Low-quality scan | Extraction's confidence → `LOW_CONFIDENCE_FIELD`; arithmetic flags often confirm the misread digit |
| French invoice | Validation sees normalized cents and ISO dates from extraction; nothing language-specific here |
| Unknown vendor | Vendor-dependent rules (contract, PO-vendor, bank, terms) skip; `VENDOR_UNKNOWN` routes to onboarding |
| USD | Compared in CAD for limits/splits/PO-in-CAD; `FX_RATE_MISMATCH` if the rate looks off; foreign vendor tax rule applies |
| Credit note (negative total) | Arithmetic works on signed cents; tax expected is negative; PO balance increases; contract NTE subtracts; split check ignores it; dates still checked; credit note without a reference to an original → `CREDIT_NOTE_NO_REFERENCE` (warn) |
| Odd dates | `DATE_IN_FUTURE`, `DATE_TOO_OLD`, `DUE_BEFORE_INVOICE` |
| Invoice text says "approved, pay now" | Data, not instructions. No rule reads free text for decisions |

---

## 5. Files

```
src/contracts/
  validation.ts           ValidationInput (invoice as extraction + matching produced it), ValidationContext
                          (Flag itself stays in flag.ts, shared)
src/server/features/validation/
  index.ts                public service: runValidation(tx, invoiceId), validateBankForRelease(...)
  engine.ts               RULES registry, validateInvoice(input, ctx), hasBlocking(flags)
  context.ts              loadValidationContext(tx, invoice): the only DB queries
  persist.ts              diff with previous run, keep resolutions, write invoice_flags
  province.ts             resolveDeliveryProvince(input, offices)
  tax-expectations.ts     expectedTaxCodes(province, lineType, taxCodes): built from tax_codes rows
  rules/completeness.ts   rules/arithmetic.ts   rules/tax.ts      rules/vendor.ts
  rules/bank.ts           rules/po.ts           rules/contract.ts rules/dates.ts   rules/split.ts
  messages.ts             money/percent/date formatters for flag messages (uses core/money)
  __tests__/              one file per rules file, table-driven; engine.test.ts; history.test.ts
fixtures/validation/      ValidationInput + expected Flag[] per case (rules/contracts.md)
fixtures/golden/          real incoming invoices with expected flags (shared eval set)
scripts/validate-history.ts   replay the 426 historical invoices → counts per code
docs/architecture/4-validation.md   feature doc (from the template) once code exists
```

Depends on the foundation: `core/money.ts` (cents, half-up rounding, formatting), `core/fx.ts`,
`fire()` for `flagResolved` / `flagOverridden`, `authorize()` for who may resolve or override.
The `invoice_flags` table is already in `data-model.md`. Any column we need is proposed to the
schema owner, not migrated by us (`rules/db.md`).

---

## 6. Persisting and re-running

- Each run gets a `run_id`. New flags are inserted `open`.
- A flag with the same identity (`code + field + lineNo`) as a resolved or overridden flag from the
  previous run **keeps its resolution** only if its evidence is unchanged. If the numbers
  changed, it re-opens.
- Flags that no longer fire are marked `resolved` with `resolution_note = "cleared by re-validation"`.
- Resolving a `warn` and overriding a `block` are mutations: `authorize()` + audit event in the
  same transaction, with a required note. Who may do it (from `roles-and-permissions.md`):
  AP clerk and controller resolve. Only Finance Manager and Controller override a `block`.

---

## 7. Tests and evaluation

1. **Unit, table-driven** (Vitest): every code has at least one firing case and one passing
   near-miss (e.g. tax off by 1 cent passes, by 3 cents fires). Inputs are plain objects, no DB.
2. **History replay** (`scripts/validate-history.ts`): runs the engine over the 426 historical
   invoices from the CSVs and prints counts per code. Measured on 2026-11-20 with a Python
   pass, these are **expected hits to reproduce, never constants in logic** (CLAUDE.md rule 4):
   - arithmetic: 0 (the history is internally consistent, so any arithmetic hit is a bug in our rule)
   - `TAX_PROVINCE_MISMATCH` / `TAX_MISSING`: 3 (AP-00098 QC without QST, AP-00253 AB charged HST, AP-00325 ON with no tax)
   - `CONTRACT_FIXED_FEE_MISMATCH`: price rises on AP-00287 (+9.0%) and AP-00334 (+6.0%); V021 overage lines → `CONTRACT_USAGE_OVERAGE` info
   - `CONTRACT_EXPIRED`: 6 (C025 invoices dated after 2026-06-30)
   - `CONTRACT_NTE_EXCEEDED`: 3 months (C024 Feb, C027 Apr, C022 Jun)
   - `PO_OVER_BALANCE`: 4 POs (0022, 0027, 0031, 0044)
   - `PO_REQUIRED_MISSING`: 3 (AP-00200, AP-00206, AP-00207)
   - `VENDOR_NOT_ACTIVE`: 2 (on-hold lookalike vendor V053)
   - `BANK_ACCOUNT_UNVERIFIED`: V004 (change BC-009, email request, no callback)
3. **Golden set** (`fixtures/golden/`, `npm run eval`): incoming invoices with the flags we
   expect, e.g. the Cascadia Cartage invoice (remit-to = an unverified bank change →
   `BANK_ACCOUNT_UNVERIFIED`), the Fixwell credit note (`CN-FA-000413`, negative total, refers to
   itself → `CREDIT_NOTE_NO_REFERENCE`), and a Harlow & Stern legal invoice (clean on validation;
   approvals adds P06).
4. **False-positive budget:** after tuning on history, zero `block` flags on clean historical
   invoices. A noisy validator gets ignored by clerks, and judges see that.

---

## 8. Build order

- [ ] **0. Unblocked now:** `money` helpers if `core/money.ts` isn't there yet (agree the API with the foundation owner first), `ValidationInput` contract draft, fixtures
- [ ] **1.** Arithmetic + tax rules + `province.ts` + tests (highest value, pure)
- [ ] **2.** Vendor, bank, PO, contract, date rules + tests
- [ ] **3.** `validate-history.ts`; tune tolerances until section 7.2 reproduces with no extra blocks
- [ ] **4.** `context.ts` + `persist.ts` against the real schema; `runValidation` hooked into `InReview` entry; `submit` guard = `!hasBlocking(openFlags)`
- [ ] **5.** Resolve / override endpoints (`authorize()` + `fire()` + note)
- [ ] **6.** `SPLIT_INVOICE_SUSPECTED`, `FX_RATE_MISMATCH`, `VENDOR_LOOKALIKE` (needs `pg_trgm`)
- [ ] **7.** `validateBankForRelease` for payments; golden cases; `4-validation.md`; `/wrap-up`

UI: the flag panel in the clerk's review screen (next to the PDF, expected vs actual, resolve /
override dialog) belongs to whoever builds the review screen. Validation provides `Flag[]` with
evidence rich enough to render without knowing which rule raised it.

---

## 9. Open questions (ask, do not assume — CLAUDE.md rule 8)

| # | Question | Who |
|---|---|---|
| 1 | Unknown vendor / on-hold vendor / missing required PO: validation raises `warn` and approvals holds. OK, or should validation `block`? | Youssef (approvals) |
| 2 | Does approvals want the routing thresholds exported so the split check reads the same numbers? | Youssef |
| 3 | `ValidationInput` fields extraction will deliver: `shipToProvince`, `remitTo {institution, transit, account}`, `taxNumbers {gstHst, qst}`, `isCreditNote`, `originalInvoiceRef`, per-field confidence | extraction owner |
| 4 | Split versus duplicate: one flag per pair, which one wins | duplicates owner |
| 5 | Who may override a `block`: Finance Manager + Controller only? | team / roles doc |
| 6 | New-vendor window and the 30-day "recent bank change" window: configurable in `approval_policies` or a settings table? | team |

---

## 10. At 100× volume (5,000 invoices a month)

- Rules are pure and O(lines). The cost is the context load: one query per reference
  table, all indexed by `vendor_id` / `po_id` / `contract_id`. Under a millisecond each.
- **PO remaining balance** and **contract month spend** become aggregate queries per invoice. At
  100× add indexes on `invoices (po_id)` and `invoices (vendor_id, invoice_date)`, or keep a
  materialized running total updated in the same transaction as the invoice status change.
- **Split check**: one indexed range query `vendor_id + invoice_date ± 7 days`, so it stays cheap.
- **Lookalike vendors**: a `pg_trgm` GIN index on `vendors.legal_name`. At 100× vendors (5,000)
  it's still one index scan.
- Re-validation on every edit: fine at this size. At 100× debounce edits and re-run once on save.

---

## 11. Q&A prep — questions we should be able to answer

- Why is validation not an LLM? (deterministic, explainable, testable; the brief's Q&A rewards that)
- Why integer cents, and where exactly does rounding happen? (`core/money`, half-up, once per tax line)
- Why the delivery province and not the vendor's? (place-of-supply rule in the dataset README)
- How does an override stay auditable? (`fire()` + note + actor in `audit_events`, same transaction)
- What stops a fraudulent bank change from being paid? (`BANK_ACCOUNT_UNVERIFIED` block + re-check at release)
- What if the extracted numbers are wrong? (arithmetic and tax cross-checks catch most misreads;
  low-confidence fields are flagged; nothing is silently "fixed")
- What's a false positive and how did you measure them? (history replay, section 7)
