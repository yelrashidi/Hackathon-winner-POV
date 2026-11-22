# TODO

**The full queue, not the orientation file** — [`../STATUS.md`](../STATUS.md) is that. Grep your
feature's section. Finished items move to [`tasks-completed.md`](tasks-completed.md) with a date.

**Every item names its owner** — the section owner by default; an item someone else picks up
ends with their name in brackets: `[Youssef]`. P0 items get a name before work starts.
Team: Arpan, Youssef, Andrew, Katie.

Priorities: **P0** blocks others · **P1** required feature · **P2** polish · **P3** bonus.
Bugs: [`../bugs/bugs.md`](../bugs/bugs.md).

## Review findings — 2026-11-21

Reviewed main `39dc2ac` (including the findings first reproduced on `96bffe4`). These are open defects, not completed work.

- [ ] P1 **High: validate pay dates before writes.** `src/server/features/payments/rules.ts:297` only compares date strings, so `payDate: "2026-99-99"` passes the rules and the database insert then throws (a server error, not a reason). Atomic since 2026-11-21: payment, `fire()` and audit are one transaction, so nothing is written (checked: 0 rows, invoice still Approved). Still to do: parse the request with a real calendar-date schema and refuse with a reason. [Katie]
- [ ] P1 **Medium: retain bank-account currency when changing details.** `src/server/features/payments/service.ts:542` hardcodes new accounts to CAD; replacing a USD account creates a verified CAD account and prevents USD release. Accept and validate the intended account currency through the server and UI contract, preserve it through verification, and cover USD replacement and retry. [Katie]
- [ ] P1 **Medium: include the Next.js app in CI.** `.github/workflows/ci.yml:33` runs `typecheck`, but `tsconfig.json:19` includes only shared source and scripts; CI never builds the app. Add a production build (which generates and checks route types) or `next typegen` plus `tsc --noEmit -p tsconfig.next.json`, and lint. A type error in an app page must fail CI. [Andrew]

## P0 — Foundation (everyone waits on these)

- [ ] Kickoff: settle the open decisions in `STATUS.md`; fill in owners.
- [ ] Next.js app scaffold, TypeScript strict, lint, `npm run typecheck`, test runner. [_name_]
- [ ] `core/money.ts`, `core/fx.ts` (validation's `lib/money.ts` is the candidate to promote). `core/audit.ts` done 2026-11-21. [_name_]
- [ ] Session + role switcher over seeded users. Katie's `src/server/session/` exists; still to do: read users from the `users` table and hand services an `Actor` (`src/contracts/actor.ts`). [_name_]
- [ ] `src/contracts/` for every stage + one fixture each. Approvals + shared `Flag` done 2026-11-21 (`fixtures/approvals/`). [_name_]
- [ ] Add `zod` and `vitest` to `package.json`; approvals tests already use them (`npx vitest run src/server/features/approvals`). [_name_]
- [ ] State machine gaps: credit-note path, hold at release time (bank change / duplicate found), payment as its own lifecycle. [_name_]

## 1 Intake — owner: Arpan

### Step 3 — persist intake results and show them as draft bills [Arpan]
Design: `docs/architecture/1-intake.md` + `2-extraction.md`. Today `classifyEmail()` returns
`{ classification, readings }` and nothing is stored. In order:

- [ ] P0 Agree with the schema owner (`STATUS.md`) that the intake tables go in first, and settle the ORM decision (recommended: Drizzle). Shared schema → `schema:` in the PR title. [Arpan]
- [ ] P1 Migration: `inbox_messages` (source, external_id **UNIQUE (source, external_id)**, from/to, subject, received_at, body_text, decision, kind, reason, decided_by, signals jsonb). Update `data-model.md` in the same PR. [Arpan]
- [ ] P1 Migration: `documents`: one row per attachment (inbox_message_id, filename, mime, size, **sha256**, storage_key, verdict `bill`/`not_bill`/`uncertain`, document_type, reason, decided_by, text_layer_chars, signals). Every attachment is kept, bills or not, so the dashboard can show why. [Arpan]
- [ ] P1 Migration: intake columns on `invoices` (status, document_id, source, vendor_name_raw, invoice_number, invoice_number_norm, dates, currency, subtotal/total cents, payment_terms_days, po_number, ship_to_province, is_credit_note, **extraction_raw jsonb**, extraction_confidence jsonb, extraction_warnings) + `invoice_lines` + `invoice_taxes`. [Arpan]
- [ ] P1 Document store `storeDocument(bytes) → { sha256, storageKey }`: local folder in dev (gitignored), Supabase Storage when deployed; identical bytes stored once. [Arpan]
- [ ] P1 `saveIntakeResult(msg, result)` in `src/server/features/intake/`: ONE transaction for the email, its documents, invoices, lines, taxes and audit events (actor = system intake user). Re-running the same email changes nothing. [Arpan] — *mostly covered by `ingestFromIntake` (`src/server/pipeline/intake.ts`, 2026-11-21, Andrew): idempotent, documents rows with sha256, audit as system; each bill is its own transaction, the email row is written first.*
- [ ] P1 Starting status per document: bill with fields → `Received` → `InReview` (`extractionSucceeded`); bill with no fields → `ManualEntry` (`extractionFailed`); **uncertain → an invoice in `Received` with flag `DOCUMENT_TYPE_UNCERTAIN`** (its own dashboard item, even when the same email had a bill); not a bill → `documents` row only. Transitions only through `fire()`. If `fire()` is not ready, create in `Received` and add the transitions when it lands. [Arpan] — *bill with fields and bill with no fields done in `ingestFromIntake`; **still open:** uncertain → `Received` + `DOCUMENT_TYPE_UNCERTAIN` (today the email lands in triage as `needs_review` and no invoice is made), and the not-a-bill `documents` row.*
- [ ] P1 Mapper `ExtractedDocument` → invoice / lines / taxes rows; `invoice_number_norm` = upper-case, no spaces or dashes (duplicates search uses it). [Arpan] — *done: `readingToValidationInput` → `ingestInvoice` writes all three and the norm.*
- [ ] P1 Clerk decision on uncertain documents: "It's a bill" → `ManualEntry`/`InReview`; "Not a bill" → `Voided` (`markNotInvoice`). `authorize()` first, audit in the same transaction. [Arpan]
- [ ] P1 Gmail cursor moves from `.intake/gmail-state.json` to a DB row. (Both sources are wired to `ingestFromIntake` via `scripts/intake-save.ts` — 2026-11-21, Andrew; the cursor now advances only after every new email is saved.) [Arpan]
- [ ] P1 Deployed intake/extraction must inject vendor domains and tax codes from the DB; keep `intake/dataset/vendors.ts` and `extraction/tax-codes.ts` as CLI/development/fixture adapters only. [Arpan]
- [ ] P1 Tests: idempotent re-run, rollback leaves nothing half-written, two-invoice email → two invoices, uncertain document → its own item, receipt PDF → `documents` row and no invoice. [Arpan]

### After step 3 [Arpan]
- [ ] P0 Rehearse `docs/demo-workflow.md` end to end on live mail: Polar 000975 emailed → Paid; 000963 emailed → `DUPLICATE_INVOICE` (not yet run live). Pick and rehearse the $10k–$50k bill for the P11 twist. [Arpan]
- [ ] P2 Test the first-run backfill (`GMAIL_BACKFILL`, `scripts/gmail-poll.ts:34`): move the choice into a small function in `intake/gmail/` and unit-test no cursor + env → backfill, cursor + env → incremental. [Arpan]
- [ ] P1 Step 4: clerk inbox dashboard. Emails with decision + reason, each document's verdict, PDF viewer through `/api/documents/[id]` (`authorize()` before streaming), and a "Needs a decision" queue for uncertain documents. [Arpan]
- [ ] P1 Upload → `documents` + draft invoice: same `readDocument` + `saveIntakeResult` path, source `upload`. [Arpan]
- [ ] P1 Click through employee **Upload a bill** in the Docker demo: drop a PDF as the Employee → Submit to AP → it shows in My bills ("in checks") and in the clerk's Checks with the employee as requester. [Arpan]
- [ ] P1 Deployed polling: a cron route calls `pollGmail` (Vercel cron), cursor in the DB. [Arpan]
- [ ] P2 Lookalike sender: validation already flags it (`src/server/features/validation/rules/vendor.ts:131`). Intake only has to pass `fromAddress` through as `senderEmail`. Check it end to end. [Arpan]

## 2 Extraction — owner: Arpan
- [ ] P1 Cache readings by document sha256, so a resubmitted PDF costs no model call. [Arpan]
- [ ] P2 Retry a low-confidence text-layer read as a PDF (layout) read; multi-column text can come out of order. [Arpan]
- [ ] P2 Move `extraction/amounts.ts` into `core/money.ts` when the foundation exists. [Arpan]

## 3 Coding — owner: Youssef
- [ ] P2 Optional LLM fallback for lines with no evidence, once the provider is decided; output must pass the expense-account check. [Youssef]

## 4 Validation — owner: Andrew
- [ ] P1 HTTP route handlers / server actions over `overrideFlag` / `resolveFlag` (services done; map `FlagActionError.status` / `Forbidden` to the response). [Andrew]
- [ ] P2 `validateBankForRelease(vendorId, bankAccountId)` for payments (7) at release time. [Andrew]
- [ ] P2 Add the incoming fixtures' expected flags to the shared `fixtures/golden/` + `npm run eval`. [Andrew]

## 5 Duplicates — owner: Arpan
- [ ] P1 Payments: call `checkDuplicatesAndPersist(invoiceId)` at release and block on open `duplicates` block flags once `getOpenInvoiceFlags` reads stored flags (AP-00407 is scheduled with an open DUPLICATE_INVOICE). [Katie, Arpan]
- [ ] P2 Approvals: after "not a duplicate", route on `SPLIT_IF_NOT_DUPLICATE.evidence.combinedCadCents` like `SPLIT_INVOICE_SUSPECTED` (today only a visible warning). [Youssef]
- [ ] P2 Store `card_transactions.vendor_id` once at import (merchant match), add an index on `(amount_cad_cents, posted_date)`. [Arpan]

## 6 Approvals — owner: Youssef
- [ ] P1 On invoice edit call `reapprovalReasons`; non-empty → bump `invoices.version`. [Youssef]
- [ ] P2 Approval queue and Checks load every open invoice per request; paginate and push the reason calculation into SQL before volume grows. [Youssef]
- [ ] P2 Daily `approvalAging` job: reminders and escalation notices. [Youssef]

## 7 Payments — owner: Youssef
## 7 Payments — owner: Katie

## 8 Audit + foundation — owner: Andrew
- [ ] P1 Team decisions in `docs/architecture/8-audit.md`: Controller audit access, historical `rejected` → `Voided`, schema-merge owner. [_name_]
- [ ] P2 Deploy the DB on Supabase: `db:migrate` + `db:seed` with the direct URL, `ALTER ROLE ap_app LOGIN PASSWORD …`, app uses the pooled URL. [Andrew]
- [ ] P2 Apply the `data-model.md` column additions listed in `8-audit.md` ("To apply at merge"). [Andrew]
- [ ] P3 Hash-chain `audit_events` (tamper evidence on top of the trigger + grants). [Andrew]

## Dashboard — owner: Youssef
- [ ] P2 Real sign-in instead of the demo cookie (server session stays the only source of the actor). [Youssef]
- [ ] P2 Uploaded files to object storage (Supabase Storage) instead of `UPLOAD_DIR`; only `pipeline/documents.ts` changes. [Youssef]
- [ ] P2 Needs-attention renders one payments state load per flag list; compute who can clear flags once per page. [Youssef]

## 9 Vendors — owner: Andrew (server side)
- [ ] P2 Bank changes exist in payments (Katie) and `features/vendors`, both on Postgres and compatible (same rows, statuses, audit names; verified both directions). The dashboard's Vendors screen calls `features/vendors` (2026-11-21, Youssef); payments' detail page still has its own form — switch it too, or drop payments' copy. [Katie / Andrew]
- [ ] P2 Edit vendor fields after onboarding (name / tax number changes as a reviewed action). [Andrew]

## P3 — Bonus (only after 1–9 work)
- [ ] Pick one at kickoff — candidates in [`../product.md`](../product.md#out-of-scope-until-19-work). [_name_]
