# Fixed bugs

Kept for the Q&A and so the same trap is not hit twice. If a fix taught a rule, the rule line in
`docs/rules/` cites this id.

| ID | Severity | Fixed by | Fixed | Summary |
|---|---|---|---|---|
| BUG-Andrew-01 | High | Andrew | 2026-11-21 | Empty string in an extracted field crashed validation |
| BUG-Andrew-02 | High | Andrew | 2026-11-21 | Impossible dates (2026-02-30) rolled over and raised false date flags |
| BUG-Andrew-03 | High | Andrew | 2026-11-21 | Unmapped tax line produced a false blocking TAX_MISSING |
| BUG-Arpan-01 | High | Arpan | 2026-11-21 | Any PDF in an email that said "invoice" became a draft bill |

---

<!-- Entry format: the open entry from bugs.md, plus
**Fix.** What changed (`file:line`, commit sha).
**Why it happened.** The real cause, in one or two lines.
**Rule added.** docs/rules/<file>.md, or "none — one-off".
-->

### BUG-Arpan-01
**Any PDF in an email that said "invoice" became a draft bill** · High · FIXED · found 2026-11-21 by Arpan testing `gmail:poll` (with and without the model)

**Symptom.** An email with invoice wording plus a non-invoice PDF (terms, brochure, receipt) drafted a bill for every PDF attached.
**Cause.** The intake rule "document attached + invoice words in subject/body → invoice" listed every attachment as a bill without opening any of them.
**Fix.** The email's wording no longer makes a bill. Each document is read by extraction (`src/server/features/extraction/read-document.ts`): text-layer rules on the document's own text, then one Claude read. Only `invoice` / `credit_note` documents go into `invoiceAttachments` (`decideFromDocuments`, `src/server/features/intake/classify/classify.ts`). Uncommitted on `1209322`. Tests: "drafts nothing when 'Invoice attached' carries a non-invoice PDF". Checked live: a receipt, a quote and a terms PDF were not drafted.
**Rule added.** `docs/rules/backend.md`: a document's type comes from the document, never from the email.

### BUG-Andrew-01
**Empty string in an extracted field crashed validation** · High · FIXED · found 2026-11-21 by a review session (Andrew's)

**Symptom.** `validateInvoice({ …, invoiceNumber: "" })` threw a ZodError instead of flagging the field missing.
**Cause.** Optional strings were `z.string().trim().min(1).nullable()`: `""` failed `min(1)`.
**Fix.** `src/contracts/validation.ts`: blank or whitespace → `null` for every optional string, date, tax code and remit-to field (`blankToNull`). Uncommitted on `bb44a67`.
**Why it happened.** Treated "missing" as only `null`; extractors emit `""` for unreadable fields.
**Rule added.** docs/rules/contracts.md.

### BUG-Andrew-02
**Impossible dates rolled over and raised false date flags** · High · FIXED · found 2026-11-21 by a review session

**Symptom.** Invoice date `2026-02-30` was read as March 2: false `DATE_TOO_OLD` (223 days) and `TERMS_MISMATCH` (252 days).
**Cause.** Dates were checked by regex only; `Date.UTC(2026, 1, 30)` silently normalises to March 2.
**Fix.** `lib/dates.ts` `isRealDate()` and `toUtcDay` refuses impossible dates; `derive.ts` `setAsideInvalidDates()` removes them before any rule runs (received date falls back to today); new `INVALID_DATE` (block) flag. Uncommitted on `bb44a67`.
**Why it happened.** Trusted the YYYY-MM-DD shape as a real date.
**Rule added.** docs/rules/contracts.md.

### BUG-Andrew-03
**Unmapped tax line produced a false blocking TAX_MISSING** · High · FIXED · found 2026-11-21 by a review session

**Symptom.** A tax line with `code: null` ("TVH (13 %)") gave `TAX_CODE_UNKNOWN` and also `TAX_MISSING: No tax charged…`, which is false.
**Cause.** The unmapped line was dropped from the charged set, so the rule saw no tax at all.
**Fix.** `tax-expectations.ts` `inferTaxCode()`: code inferred only when label family AND printed rate match exactly one `tax_codes` row; `rules/tax.ts`: while any line stays unmapped, nothing is reported missing (wrong mapped codes still are). Uncommitted on `bb44a67`.
**Why it happened.** "Not mapped" was treated as "not charged".
**Rule added.** docs/rules/money-and-tax.md.
