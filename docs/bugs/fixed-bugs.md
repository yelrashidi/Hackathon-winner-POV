# Fixed bugs

Kept for the Q&A and so the same trap is not hit twice. If a fix taught a rule, the rule line in
`docs/rules/` cites this id.

| ID | Severity | Fixed by | Fixed | Summary |
|---|---|---|---|---|
| BUG-Youssef-01 | High | Youssef | 2026-11-21 | A delegate could approve their absent boss's own request |
| BUG-Youssef-02 | High | Youssef | 2026-11-21 | An unconverted USD total routed to too few approvers |
| BUG-Youssef-03 | Medium | Youssef | 2026-11-21 | Leave or termination after routing left nobody able to approve |
| BUG-Youssef-04 | Medium | Youssef | 2026-11-21 | Overriding `PO_OVER_BALANCE` removed the P12 finance review |
| BUG-Youssef-05 | Medium | Youssef | 2026-11-21 | `applyDecision` could record a different actor or action than was checked |
| BUG-Youssef-06 | Low | Youssef | 2026-11-21 | Form fields rendered unstyled: a server page read a class string from a "use client" file |
| BUG-Youssef-07 | Medium | Youssef | 2026-11-21 | Every unconfirmed bill showed as "Blocked" in Checks |
| BUG-Andrew-01 | High | Andrew | 2026-11-21 | Empty string in an extracted field crashed validation |
| BUG-Andrew-02 | High | Andrew | 2026-11-21 | Impossible dates (2026-02-30) rolled over and raised false date flags |
| BUG-Andrew-03 | High | Andrew | 2026-11-21 | Unmapped tax line produced a false blocking TAX_MISSING |
| BUG-Andrew-04 | Medium | Andrew | 2026-11-21 | A refused coding attempt hung the request instead of returning 403 |
| BUG-Andrew-05 | Low | Andrew | 2026-11-21 | Seeded history showed a payment "scheduled" after it was released |
| BUG-Andrew-06 | High | Andrew | 2026-11-21 | Intake scripts never saved anything: the DB adapter existed but nothing called it |
| BUG-Andrew-07 | Low | Andrew | 2026-11-21 | Intake scripts' shutdown crashed on the embedded demo database |
| BUG-Andrew-08 | Medium | Andrew | 2026-11-21 | Any signed-in role could open any invoice PDF by its id |
| BUG-Arpan-01 | High | Arpan | 2026-11-21 | Any PDF in an email that said "invoice" became a draft bill |
| BUG-Arpan-02 | High | Arpan | 2026-11-21 | Gmail advanced its cursor past messages excluded by the delivery cap |
| BUG-Arpan-03 | High | Arpan | 2026-11-21 | Credit notes kept positive amounts when their total was missing or already negative |
| BUG-Arpan-04 | Medium | Arpan | 2026-11-21 | Missing line values silently became zero amounts or quantity one |
| BUG-Arpan-05 | Medium | Arpan | 2026-11-21 | DB tests picked "the first row" without ORDER BY and broke when the seed wrote more rows |
| BUG-Arpan-06 | Medium | Arpan | 2026-11-21 | Duplicates page queried the DB while Next.js prerendered and the route errored on the embedded DB |
| BUG-Arpan-07 | High | Arpan | 2026-11-21 | Bills emailed before the Gmail poller's first run never reached the dashboard |
| BUG-Katie-01 | High | Katie | 2026-11-21 | Release said "No approval record was found" in the app while tests passed |
| BUG-Katie-02 | Medium | Katie | 2026-11-21 | `import "server-only"` made `npm run check` fail |
| BUG-Katie-03 | Medium | Andrew | 2026-11-21 | `.env.example` was referenced but not in the repo |

---

### BUG-Arpan-02
**Gmail cursor skipped overflow mail** · High · FIXED · found 2026-11-21 in Claude's PR #11 review

**Cause.** History polling stopped at `maxMessages`, sliced away surplus ids, then returned the mailbox's latest history id. Backfill also read only its first page.
**Fix.** Drain every page, deduplicate ids and fetch all messages before returning the cursor (`src/server/features/intake/gmail/poll.ts:65`, `:102`). Tests in `intake/__tests__/gmail-poll.test.ts` cover 60 messages with a cap of 2, later/empty pages, duplicate ids, paginated backfill and API failures. Rule: backend cursor advancement follows complete delivery.

### BUG-Arpan-03
**Credit signs depended on the total** · High · FIXED · found 2026-11-21 in Claude's PR #11 review

**Cause.** The normalizer flipped credit amounts only when the total was readable and positive.
**Fix.** Normalize every monetary field independently when the type is `credit_note`, preserve null totals and warn only if a positive amount changed (`src/server/features/extraction/normalize.ts:70`). Regression cases cover blank/unreadable/negative totals, mixed signs and zero tax. Rule: money-and-tax credit normalization is per field.

### BUG-Arpan-04
**Missing line values looked certain** · Medium · FIXED · found 2026-11-21 in Claude's PR #11 review

**Cause.** Required numeric line schemas forced defaults, but blank amounts had no warning; quantity defaulted to 1 and unit price could copy the line amount.
**Fix.** Parse each line field once, keep explicit numeric placeholders, warn for every missing/unreadable required field and set line confidence to zero (`src/server/features/extraction/normalize.ts:37`). Tests distinguish missing/unreadable amounts and quantity from a genuine printed zero. Shared contracts stay compatible. Rule: placeholders require manual review.

### BUG-Youssef-01
**A delegate could approve their absent boss's own request** · High · FIXED · found 2026-11-21 by Youssef

**Symptom.** Liam (on leave, delegate Elise) requests a Facilities invoice; it routes to Elise "on behalf of Liam": Liam approving Liam.
**Fix.** Exclusions are checked before leave, so an excluded person is escalated, never delegated (`src/server/features/approvals/resolve.ts:48`, `fb86afa`).
**Why it happened.** The resolver followed the delegation first and only then asked whether the person may sign.
**Rule added.** `docs/rules/backend.md`.

### BUG-Youssef-02
**An unconverted USD total routed to too few approvers** · High · FIXED · found 2026-11-21 by Youssef

**Symptom.** A US$9,000 invoice passed in as $9,000 CAD (really $12,330) skipped the finance-manager step.
**Fix.** Routing re-checks `total × fx_rate = total_cad` (±1¢), rate 1 for CAD only; otherwise hold (`route.ts:299`, `fb86afa`).
**Why it happened.** Approvals trusted `totalCadCents` blindly; nothing upstream guarantees the conversion happened.
**Rule added.** `docs/rules/money-and-tax.md`.

### BUG-Youssef-03
**Leave or termination after routing left nobody able to approve** · Medium · FIXED · found 2026-11-21 by Youssef

**Symptom.** Routed to Dev; Dev is then terminated: every approve attempt is `NOT_ASSIGNED`, forever.
**Fix.** `checkDecision` re-resolves the current step against today's directory (`decide.ts:150` → `resolve.ts:186`, `fb86afa`).
**Why it happened.** The decision trusted the assignee stored at routing time.
**Rule added.** `docs/rules/backend.md`.

### BUG-Youssef-04
**Overriding `PO_OVER_BALANCE` removed the P12 finance review** · Medium · FIXED · found 2026-11-21 by Youssef

**Symptom.** A clerk overrides the over-balance flag; the invoice routes without the finance manager.
**Fix.** Overridden flags still drive routing (only `resolved` ones are ignored), and the overrider cannot approve (`route.ts:63`, `route.ts:112`, `fb86afa`).
**Why it happened.** "Overridden" was treated as "no longer true"; an override only unblocks.
**Rule added.** `docs/rules/backend.md`.

### BUG-Youssef-05
**`applyDecision` could record a different actor or action than was checked** · Medium · FIXED · found 2026-11-21 by Youssef

**Symptom.** A handler could check `reject` for one user and then apply `approve` for another; nothing stopped it.
**Fix.** `applyDecision` takes the actor and request from the check result only (`decide.ts:200`, `fb86afa`).
**Why it happened.** Actor and action were separate arguments to the write.
**Rule added.** `docs/rules/backend.md`.

Seven smaller ones fixed in the same unit are listed in [`6-approvals-edge-cases.md`](../architecture/6-approvals-edge-cases.md) §10.

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

### BUG-Katie-01
**Release said "No approval record was found" in the app while tests passed** · High · FIXED · found 2026-11-21 by Katie

**Symptom.** On `npm run dev`, every release on `/payments` was refused with "No approval record was found"; `flow.test.ts` passed.
**Cause.** Next.js loads server code more than once (one module copy per server bundle), so each copy of `features/approvals` has its own default store. The seed flag sat on `globalThis`, so only the first copy got the approval history.
**Fix.** The seed is memoized per module copy, not on `globalThis` (`src/server/features/payments/fake-data/approval-seed.ts:86`, `0fa1e56`).
**Why it happened.** Assumed one module instance per process, which is true under vitest and tsx but not under Next.
**Rule added.** docs/rules/backend.md.

### BUG-Katie-02
**`import "server-only"` made `npm run check` fail** · Medium · FIXED · found 2026-11-21 by Katie

**Symptom.** `npm run check:imports` threw on `src/server/session/*.ts`.
**Cause.** `scripts/check-imports.ts` imports every module under `src/` with tsx; `server-only` throws outside Next's server build.
**Fix.** Removed the import from `src/server/session/` (`d87deef`). The browser still never reaches it: only server components and server actions import it.
**Why it happened.** `server-only` is a Next-only guard; our checks run outside Next.
**Rule added.** docs/rules/backend.md.

---

### BUG-Andrew-04
**A refused coding attempt hung the request instead of returning 403** · Medium · FIXED · found 2026-11-21 by Andrew (pipeline test)

**Symptom.** The auditor calling `codeInvoiceLine` never returned. Every later test on that database timed out.
**Cause.** `authorize()` ran *inside* `withAction`, and on refusal `recordDenied()` opened a second transaction while the first still held the connection. On PGlite (one connection) it waits forever; on Postgres it uses up a second pooled connection per refusal.
**Fix.** Authorize, and log refusals, **before** the transaction opens, as every other service does (`src/server/pipeline/coding.ts`, `authorizeCoding`).

### BUG-Andrew-05
**Seeded history showed a payment "scheduled" after it was released** · Low · FIXED · found 2026-11-21 by Andrew (audit fixture review)

**Symptom.** In AP-00098's timeline, "released" (03-28) came before "scheduled" (03-29).
**Cause.** `payments.csv` `scheduled_date` is the *planned* pay date and can fall after the actual `paid_date`. The CSV doesn't record when the payment was scheduled.
**Fix.** The seed places `payment.scheduled` at the earlier of the two dates, keeps `plannedDate` in `after`, and marks `metadata.timeApproximate` (`src/server/db/seed/seed.ts`).

### BUG-Andrew-06
**Intake scripts never saved anything: the DB adapter existed but nothing called it** · High · FIXED · found 2026-11-21 by a teammate reviewing PR #12

**Symptom.** `npm run gmail:poll` and `npm run intake:dataset` classified and printed each email; no invoice reached Postgres.
**Cause.** `ingestFromIntake` was built and tested on fixtures, but the two entry points were never switched to it. The Gmail cursor was also saved *before* processing, so once saving existed a DB error would have skipped mail for good.
**Fix.** `scripts/intake-save.ts` calls `ingestFromIntake` per email (and keeps each bill's bytes for a `documents` row); both scripts use it; Gmail's cursor advances only after every new email is saved. Verified with all 59 dataset emails, twice, into Docker Postgres.

### BUG-Youssef-06
**Form fields rendered unstyled: a server page read a class string from a "use client" file** · Low · FIXED · found 2026-11-21 by Youssef (screenshots)

**Symptom.** Inputs and selects built as `` `w-64 ${inputClass}` `` (payments' Cancel / Clear flag, Checks' coding row) had no border or size; `className={inputClass}` alone looked fine.
**Fix.** The class strings live in a plain module, `app/_lib/styles.ts`; the client `ActionForm` no longer exports them.
**Why it happened.** A server component importing a non-component value from a `"use client"` module gets a client reference, not the string; interpolating it produces garbage.

### BUG-Youssef-07
**Every unconfirmed bill showed as "Blocked" in Checks** · Medium · FIXED · found 2026-11-21 by Youssef (dashboard flow test)

**Symptom.** The Checks queue counted coding's own `CODING_NOT_CONFIRMED` (block) as a blocking flag, so all 56 incoming bills read "1 blocking flag to resolve or override".
**Fix.** The queue's blocking count leaves out `source = 'coding'` (`src/server/dashboard/checks.ts`); coding's state is shown per line instead (confirmed / unsure).
**Why it happened.** Coding stores its submit guard as an ordinary block flag on purpose (so `fire('submit')` needs no extra check); the screen must not treat it as a validation problem.

### BUG-Arpan-05
**Tests depended on heap order** · Medium · FIXED · found 2026-11-21 while adding the duplicates seed pass

**Cause.** `audit-trail.test.ts` took "the first open flag" (`LIMIT 1`, no `ORDER BY`) and assumed it was on a new invoice; `intake.test.ts` compared audit actions and "the first audit event" in physical order. Once the seed also wrote duplicate flags, Postgres returned other rows first.
**Fix.** Explicit filters and `ORDER BY id` (`src/server/db/__tests__/audit-trail.test.ts` override setup, `src/server/pipeline/__tests__/intake.test.ts:62`, `:87`, `:124`). Rule: db.md.

### BUG-Arpan-06
**DB read during prerender** · Medium · FIXED · found 2026-11-21 running `next start` on the embedded demo DB

**Cause.** With `cacheComponents`, `/payments/duplicates` started its database read while Next.js was still prerendering the shell; PGlite reads the clock, and Next refuses `Date.now()` during prerender ("encountered the unstable value `Date.now()`").
**Fix.** `await connection()` before the read (`app/payments/_lib/duplicates.ts`). Rule: frontend.md.

### BUG-Andrew-07
**Intake scripts' shutdown crashed on the embedded demo database** · Low · FIXED · found 2026-11-21 by Andrew (merging main's `npm run demo`)

**Symptom.** `intake:dataset` with `DATABASE_URL=pglite:…` would throw at the end: `$client.end is not a function`.
**Cause.** `scripts/intake-save.ts` closed the connection with postgres.js's `end()`; main added an embedded PGlite mode whose client closes with `close()`.
**Fix.** Close with whichever the client has (`end` or `close`). Verified on the embedded demo DB and Docker.

### BUG-Katie-03
**`.env.example` is referenced but not in the repo** · Medium · FIXED · found 2026-11-21 by Katie

**Symptom.** Without a `.env`, the app and `npm run db:reset` fail with "DATABASE_URL is not set (see .env.example)" (`src/server/db/client.ts:34`, `scripts/db-reset.ts:13`), and `tasks-completed.md` lists `.env.example` as landed, but no commit on any branch has the file (`git log --all -- .env.example` is empty).
**Cause.** Probably created locally and never committed (`.gitignore` un-ignores it).
**Blocks.** Everyone running the app on Postgres (now every payments page) has to guess the variable names; the local values are only in `docker-compose.yml` and `docker/init/`.
**Fix.** Committed `.env.example` (2026-11-21, Andrew, `andrew-audit-db`): `DATABASE_URL` (ap_app) and `DATABASE_URL_ADMIN` (owner) with the local Docker values from `docker-compose.yml`. It holds no secrets; API keys stay in the git-ignored `.env.local`.

### BUG-Arpan-07
**Bills emailed before the poller's first run never reached the dashboard** · High · FIXED · found 2026-11-21 by Arpan (four test invoices sent to the inbox; none showed up)

**Cause.** With no saved cursor, `pollGmail` records the current history id and returns nothing (deliberate: never read a personal inbox by accident). The `gmail-poller` container started about six hours after the test mail arrived, so that mail was behind the baseline forever. Nothing in the dashboard path was wrong: later mail was saved and shown.
**Fix.** `GMAIL_BACKFILL` (env): on the first run only (no cursor), backfill that window before going incremental (`scripts/gmail-poll.ts:34`); `docker-compose.yml` defaults it to `1d`. Saving is idempotent, so overlap is harmless. The missed mail was recovered with `--backfill 1d`. Rule: backend.md.

### BUG-Andrew-08
**Any signed-in role could open any invoice PDF by its id** · Medium · FIXED · found 2026-11-21 by Andrew (scoping invoice records)

**Symptom.** `/documents/[id]` checked only that someone was signed in, so a manager could open another department's invoice file.
**Cause.** It was written when every dashboard role read the whole audit trail; once invoices were scoped by role, the file route kept the old, wider rule.
**Fix.** The route finds the invoice the document belongs to and applies the same scope (`features/invoices` `inScope`); a file with no invoice yet (inbox attachment) is for inbox triage and audit-log roles only.
