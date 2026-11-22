# 8 — Audit trail + database foundation

**Owner:** Andrew · **Code as of:** `9ab81d4` (2026-11-22)

## What it does
Every change to an invoice, flag, approval, payment or bank account writes one row to
`audit_events`: **who** (`actor_id` + their role at the time), **on whose behalf** (`on_behalf_of`),
**when** (database clock), **what** (`action`, entity), **before / after** (JSON) and **why** (`reason`).
The row commits in the same transaction as the change, and nobody can edit or delete it afterwards.
An **auditor-only** dashboard reads it: a table of every invoice, then everything about one invoice.

## Where the code is
| Piece | File |
|---|---|
| Schema (21 tables + `payment_flags`) | `src/server/db/schema/{reference,pipeline,audit}.ts` |
| Migrations | `src/server/db/migrations/0000_init.sql` (generated), `0001_audit_guards.sql` (hand-written) |
| DB handle (`getDb`, `Db`, `Tx`) | `src/server/db/client.ts` |
| Audit emitter (`withAction`, `emit`, `recordDenied`) | `src/server/core/audit.ts` |
| State machine (`fire`) | `src/server/core/fire.ts` |
| Role matrix (`authorize`, `can`) | `src/server/core/authorize.ts` |
| **The pipeline on the DB** (ingest, review, coding, approvals) | `src/server/pipeline/` |
| Validation on the DB (`validateWithin`, flags) | `src/server/features/validation/db/` |
| Flags saved / overridden | `src/server/features/validation/db/{persist,override}.ts` |
| Auditor dashboard services | `src/server/features/audit/` |
| Contracts | `src/contracts/{actor,audit,audit-view}.ts` |
| Seed from the dataset | `src/server/db/seed/seed.ts` (`npm run db:seed` / `db:reset`) |
| Fixtures for the dashboard | `fixtures/audit/*.json` (`npm run audit:fixtures` regenerates from a real run) |
| Tests (real Postgres via PGlite) | `src/server/db/__tests__/audit-trail.test.ts`, `src/server/pipeline/__tests__/pipeline.test.ts` |

## Why nobody can change history
1. **Trigger.** `audit_events_immutable()` raises on UPDATE, DELETE and TRUNCATE for every role, the owner included.
2. **Grants.** The app connects as `ap_app`, which has no UPDATE, DELETE or TRUNCATE on `audit_events`. It can INSERT only
   the content columns, not `id` or `occurred_at`, so it **cannot backdate** an event. The time comes from `now()`.
3. **Same transaction.** `withAction(actor, fn)` opens the transaction, and `audit()` writes into it. If the change rolls
   back, so does its audit row, and the reverse holds too (tested).
4. **Nothing is deleted.** A voided invoice keeps its row, a bank change is a new `vendor_bank_accounts` version, and a
   terminated user stays so old events still show a name.

## How a teammate writes audit events
```ts
await withAction(actor /* from the session, never the browser */, async (ctx) => {
  const { tx, audit } = ctx;
  const [before] = await tx.select().from(payments).where(eq(payments.id, id)).for("update");
  await tx.update(payments).set({ status: "released", releasedBy: actor.userId }).where(eq(payments.id, id));
  await audit({ action: "payment.released", entityType: "payment", entityId: id, invoiceId: before.invoiceId,
                paymentId: id, before: { status: before.status }, after: { status: "released" } });
  await fire(ctx, before.invoiceId, "paymentSettled", { fullyPaid: true }); // status changes only via fire()
});
```
`action` must be one of `AUDIT_ACTIONS` (`src/contracts/audit.ts`). Payments' action names (`payment.on_hold`,
`payment_flag.created`, `bank_account.verified`, …) are already in the list, so `emitAudit` in
`features/payments/deps.ts` can swap to `audit()` without renaming. A delegate passes
`actor = { userId: delegate, role, onBehalfOf: absentApprover }`.

## Who sees what (per the brief)
| Screen | Who | Code |
|---|---|---|
| Audit log `/audit` — every event, before/after, control checks, export | Auditor ("read-only everything, audit export") and Controller/Admin ("full audit log") | `features/audit`, `audit.view` / `audit.export` |
| Invoice records `/invoices` — invoice, PDF, coding, flags, payment, who did what | everyone, scoped by the "View invoices" row: employee own (the bills they requested: "My bills"), manager own department, others all | `features/invoices`, `invoice.view` + `inScope` |
| Who did what (requested → checked → approved → scheduled → released) | the audit page, the invoice record, and live on Checks / Approvals / Payments | `features/audit/who-did-what.ts` |

Everyone else's home screen shows only their own recent actions. History never guesses: a step the dataset did not record (who checked an old invoice) says "not recorded".

## The pipeline on the database (features 3 → 4 → 6 → 8)
`src/server/pipeline/` wires each teammate's **pure** engine to Postgres. It doesn't edit their files; it only calls their public `index.ts`. Every call follows authorize → one transaction → audit rows → `fire()`.

| Step | Call | What happens |
|---|---|---|
| in (from 1–2) | `ingestFromIntake(message, { classification, readings })` | intake + extraction hand-off. A readable bill → `ingestInvoice`; an unreadable bill → `ManualEntry` (`extractionFailed`); not a bill → kept on `inbox_messages` with its reason. With the attachment bytes, the bill links to a `documents` row (sha256, storage key). Idempotent per (email, attachment). Called by `gmail:poll` and `intake:dataset` (`scripts/intake-save.ts`) |
| in | `ingestInvoice(validationInput, { source })` | saves the invoice, its lines and taxes → `extractionSucceeded` → **validation** (4: vendor, CAD total, flags) → **coding** (3: account and department per line, journal) |
| review | `codeInvoiceLine(actor, id, lineNo, { glAccount, departmentId, note })` / `acceptConfidentLines(actor, id)` | Youssef's `codeLine` / `acceptConfident` checks run, then `invoice.line_coded` is written |
| review | `editInvoice(actor, id, patch)` | the clerk corrects fields (for example the **requester**, which approvals needs) → `fieldsEdited` → analysis re-runs |
| review | `overrideFlag` / `resolveFlag` | a note is required, and the decision is audited |
| 6 | `submitForApproval(actor, id)` | `planApprovals` on the stored flags → plan saved via `PostgresApprovalStore` → `submit` (PendingApproval) or `hold` (OnHold). A blocked plan returns 409 with every reason |
| 6 | `decideApproval(actor, id, { action, comment, acknowledgedFlags })` | `checkDecision` / `applyDecision` / `saveDecision` → `approval.decided` (actor **and** on_behalf_of) → `stepApproved` / `stepRejected` |
| 8 | `features/audit` | the auditor sees all of it |

Safe to re-run at any time:
- **Decisions are never overwritten.** Flag overrides survive (`syncFlags`, one diff for every stage's flags), and coding lines a person confirmed are never replaced by a new suggestion.
- **Coding gates submission through the existing guard.** `CODING_NOT_CONFIRMED` (block) is stored like any flag, so `fire('submit')` refuses until every line is confirmed.
- **The learning loop reads the database.** Coding history is the past invoices plus the lines people confirmed on approved invoices, read from `invoice_lines` on each run.
- **Double-clicks are safe.** Two simultaneous approvals of one step produce one approval and one refusal (row lock + conditional update; verified on Docker Postgres).

Nothing is tied to the dataset. The DB path reproduces the CSV validator's flags on all 56 incoming invoices, and the
pipeline test drives clean invoices to Approved, a rejection to resubmission, and a blocked invoice to a 409.

**Not wired yet:**
- **7 payments:** Katie's service runs on synchronous in-memory adapters in `features/payments/deps.ts`. Its tables (`payments` with attempts and failures, `payment_flags`, versioned `vendor_bank_accounts`) and audit action names are ready here. Swapping the adapters to the DB means making them async, so it is her change to make.
- **5 duplicates:** nothing raises duplicate flags yet. The DB unique index stops two invoices with the same vendor and number from both being approved or paid.

## The auditor dashboard (for whoever builds `app/audit`)
Every function checks `authorize(actor, "audit.view" | "audit.export")`, which lets the **Auditor and the Controller/Admin** through (product.md: "full audit log"). Everyone else reads invoices through `src/server/features/invoices/` (role-scoped records + `whoDidWhat`), not the audit log. A refused
attempt throws `Forbidden` (403 with a reason) and is itself written as `authz.denied`.

| Screen | Call | Returns |
|---|---|---|
| `/audit` table | `listAuditInvoices(actor, { search, status, vendorId, from, to, hasOverrides, hasOpenBlocking, page, pageSize })` | `AuditInvoiceList` |
| `/audit/invoices/[id]` | `getInvoiceAuditDetail(actor, invoiceId)` | `AuditInvoiceDetail` |
| from a payment | `getPaymentAuditDetail(actor, paymentId)` | `AuditInvoiceDetail` |
| Export button | `exportAuditCsv(actor, { from, to, invoiceId })` | `{ csv, rows, fileName }` |

The detail has these sections, in reading order:
- invoice header and source document (sha256)
- what extraction read
- lines with GL codes, and taxes
- **validation runs** (with the vendor, contract and FX rate each verdict used)
- **flags**, with who resolved or overrode them and why
- **approval chain**: acted by, on behalf of, the role and limit *when they acted*, comment and time
- **payments**: attempts, the exact bank-account version paid to and who verified it, preparer and releaser, failures, holds and cancels
- payment flags
- **controls**: automatic pass / fail checks covering:
  - approver ≠ requester
  - limit covers the amount
  - releaser didn't approve
  - preparer ≠ releaser
  - EFT only to a verified account
  - no open blocking flag after review
  - not paid more than invoiced
- **timeline**: every event with a readable sentence

Build against `fixtures/audit/*.json` until the DB is wired. Its shapes are `src/contracts/audit-view.ts`.

## Flags it raises
None: audit records every stage's flags and the decisions taken on them. Its own findings are the
**control checks** on the invoice detail (`controls.ts`). They are recomputed on every view, never stored, and only report:

| Check id | Fails when |
|---|---|
| `APPROVER_NOT_REQUESTER` | the requester signed an approval step |
| `APPROVAL_WITHIN_LIMIT` | no approver's limit *at the time* (`acted_as`) covered the CAD amount |
| `RELEASER_DID_NOT_APPROVE` | someone who approved (or was represented by a delegate) released the payment (P11) |
| `PREPARER_NOT_RELEASER` | one person both prepared and released a payment |
| `PAID_TO_VERIFIED_ACCOUNT` | an EFT went to a bank-account version that was never verified |
| `NO_OPEN_BLOCKING_FLAGS` | a `block` flag is still open after the invoice left review |
| `PAID_NOT_MORE_THAN_INVOICED` | released + settled payments exceed the invoice total |

## Bad input
- **A non-auditor calls a read.** They get `Forbidden` (403, with a reason), and the attempt is written as `authz.denied`.
- **A malformed or browser-invented role.** The `Actor` schema refuses it before the matrix is even checked.
- **An unknown invoice or payment id.** `AuditNotFound` (404).
- **An event with an action outside `AUDIT_ACTIONS`.** Zod rejects it at `emit()`, so the transaction rolls back and the change is not saved.
- **CSV export values that look like spreadsheet formulas** (`=`, `+`, `-`, `@`). They are prefixed with `'`, so opening the file in Excel can't run them.
- **The same email polled twice, or a save that failed halfway.** `ingestFromIntake` reports `already_ingested` and reuses the `documents` row; Gmail's cursor stays put until every email is saved (BUG-Andrew-06).
- **A bill extraction could not read.** It becomes a `ManualEntry` invoice with the reason, never a guessed one.
- **History has no extraction output and no "scheduled at" time.** The detail shows `extraction.raw = null`, and those events carry `metadata.imported` / `timeApproximate`.

## At 100× volume
- **`audit_events` is the table that grows** (about 15 rows per invoice). It is indexed by invoice, payment, entity, actor and time, so one invoice's timeline is an index range scan. Partition by month past roughly 10M rows.
- **The invoice list runs about 8 correlated subqueries per row**, fine for a page of 50. At 100×, keep a summary column (flag counts, last activity) updated in the same transaction, or a materialized view.
- **The CSV export builds the whole file as one string in each call**, so keep it scoped by date range or invoice. For a full year, page by `id` and stream the file.
- **Seeding history writes about 2,000 events**, in chunks of 300. That's fine at 100×.
- **Intake saves one email at a time**, one transaction per bill. At 100× (≈5,000 emails a day) that is still seconds; the slow part is the extraction model call, not Postgres.

## Running it
Needs Docker: Docker Desktop, or without admin rights on a Mac, Colima. Colima was verified on 2026-11-21 with
`colima start --vm-type vz --cpu 2 --memory 4`, Postgres 16, and the steps below. Then:
`npm run db:up` (Docker) → `cp .env.example .env` → `npm run db:reset` (local only; it refuses a non-localhost URL)
→ `npm run db:ingest` (pushes the incoming batch through the real path). Tests need no Docker: `npm test`.
Deployed on Supabase, run `ALTER ROLE ap_app LOGIN PASSWORD '…'` once, and the app uses the pooled URL as `ap_app`.

## Decisions taken (confirm with the team)
- **Drizzle** (STATUS.md had it as the recommended open choice).
- **Audit access is auditor-only**, per the request on 2026-11-21. `roles-and-permissions.md` also lists the Controller for
  "view full audit log"; to include them, add `"controller_admin"` to `audit.view` in `authorize.ts`.
- **Historical `rejected` invoices are imported as `Voided`**, with `legacy_status = 'rejected'` kept. The state machine has no
  terminal "rejected".
- **History's audit trail is reconstructed** by the seed:
  - `invoice.imported`, `approval.decided` and `payment.*`, with the real approvers and releasers at the CSV dates
  - each marked `metadata.imported = true`
  - `payment.scheduled` times marked approximate, because the CSV has the planned date, not when it was scheduled
- **The duplicate guard in the DB** (`invoices_vendor_number_uq`) blocks two invoices with the same vendor and number from both
  being **in approval or paid**. A duplicate can still be received, so it can be flagged and voided. History is excluded
  because it contains paid duplicates.
- **`payments` follows `src/contracts/payment.ts`**: `on_hold`, `attempt_no` and failure, hold and cancel fields, plus a `payment_flags`
  table. `vendor_bank_accounts` gets `currency` (default CAD), `closed` and `verified_at`, as proposed in `data-model.md`.

## Still to apply (shared docs)
`STATUS.md`, `TODO.md`, `tasks-completed.md` and the architecture index were updated in this unit's wrap-up (2026-11-21). Left:
- **`docs/architecture/data-model.md`, the column additions**, kept out until the schema-merge owner is named:
  - `audit_events`: `id`, `request_id`, `actor_role`, `payment_id`, `metadata`
  - `invoice_flags`: `source`, `flag_key`, `invoice_version`, `resolved_at`
  - `invoices`: `legacy_status`
  - approvals: `approval_plans`, and the `approval_steps` extras
  - payments: the payments columns (`attempt_no`, failure / hold / cancel), `payment_flags`, and `vendor_bank_accounts.verified_at`
- **Youssef:** `PostgresApprovalStore` and `submitForApproval` / `decideApproval` (`src/server/pipeline/approvals.ts`) cover his Postgres-store and approve/reject TODO items at service level, and `src/server/pipeline/coding.ts` covers "persist CodingResult". He can review them, tick the items or move the code into his folder.
- **Katie:** the payments tables and audit names match `src/contracts/payment.ts`. Making the `deps.ts` adapters async over them is her TODO.

## Known gaps
- Hash chaining (tamper-*evidence* on top of tamper-*prevention*) is not built. The trigger and grants are the control.
- `authorize()` is the role matrix only. Data rules (no self-approval, P11) stay in approvals and payments.
- `revalidateInvoice` on a *historical* invoice has no extraction output, so vendor tax numbers come only from the columns.
- `db:ingest` uses the server's date as "today". Pass `today` explicitly when replaying old invoices.
