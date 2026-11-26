# Brim AP — status

**As of:** 2026-11-20 · `4860f5b` · docs set up, no code yet.

Printed at the start of every session. Orient from this, not from `TODO.md`. **Each owner edits
only their own section** (four people editing one paragraph is a merge conflict per commit);
the top block is updated by whoever finishes a shared piece.

## Team

| Owner | Features | Also owns |
|---|---|---|
| Arpan | 1 Intake, 2 Extraction, 5 Duplicates | |
| Youssef | 3 Coding, 6 Approvals, dashboard (all roles) | |
| Andrew | 4 Validation, 8 Audit + foundation (schema, `core/`, `src/server/pipeline/`), 9 Vendors (server side) | |
| Katie | 7 Payments, payments dashboard | |
| shared | foundation (`core/`) | schema merges: _name_ |

## Now (shared, in order)

1. **Kickoff decisions** (below) — 30 minutes, before any code.
2. **Foundation** — schema + seed, `fire()`, `authorize()`, audit emitter, fx/money, role-switch session. Everyone blocks on this; pair on it. _Done 2026-11-21 (Andrew, branch `andrew-audit-db`): schema + migrations + seed, `fire()`, `authorize()` (role matrix), audit emitter. Still open: `core/fx`, `core/money`, wiring the role-switch session to `Actor`._
3. **Contracts + first fixtures** for every stage in `src/contracts/` and `fixtures/`.
4. **Thin end-to-end path** — one invoice from upload to `Paid` with every stage stubbed, then replace stubs.
5. **Golden set** — 10–15 incoming invoices with expected flags and route; `npm run eval`.

## Decisions

| Decision | State |
|---|---|
| Backend inside Next.js (`src/server/`) vs separate Node server | **open** — recommended: inside Next |
| Deploy: Vercel + Supabase (Postgres + Storage) vs Railway | **open** — recommended: Vercel + Supabase |
| ORM / query layer (Drizzle, Prisma, Kysely) | **decided 2026-11-21: Drizzle** + postgres.js; tests on PGlite (in-process Postgres, no Docker) — `src/server/db/` |
| LLM provider for classification / extraction | **Claude** (`claude-opus-5-5`, `@anthropic-ai/sdk` 1.4.0) — implementation choice recorded 2026-11-21 (Arpan); team ratification still pending; `EXTRACTION_MODEL` / `INTAKE_CLASSIFIER_MODEL` can override the model |
| Money as integer cents | proposed |
| Auth: seeded users + role switcher, server session | proposed |
| Feature 9 (vendors) owner | **open** — required feature, see `product.md` |

## Per feature

### 1 Intake — Arpan
**Works (standalone, PR #11):** Gmail connector and dataset adapter → `InboxMessage`; per-document classifier; history and backfill drain every page before returning a cursor (`gmail/poll.ts:65`, `:102`, BUG-Arpan-02). Frozen message/classification fixtures in `fixtures/intake/`; `npm run fixtures:intake` replays offline. Full check: 644 tests plus batch/history pass on 2026-11-21.
**Gmail → dashboard works end to end (2026-11-21, branch `arpan/gmail-integration`):** the `gmail-poller` container saves through `ingestFromIntake`; bills land in **Checks** and on Home's **Next checks** with their open flag codes as tags. The first run (no cursor) now backfills `GMAIL_BACKFILL` (default `1d`) instead of only recording "now" — that is why emailed bills were missing (`scripts/gmail-poll.ts:34`). Live demo run sheet: [`demo-workflow.md`](demo-workflow.md).
**Stubbed:** cursor still in `.intake/` (a Docker volume); vendor domains and tax codes read from the CSVs; uncertain documents stay on the email (no `DOCUMENT_TYPE_UNCERTAIN` item yet).
**Next:** cursor in a DB row; uncertain documents as their own dashboard item (see `TODO.md` § 1–2); rehearse the duplicate catch on live mail.
**Shared changes — Youssef please review:** `dashboard/checks.ts` adds `flagTags` to `CheckRow`; `app/page.tsx` shows them on Home. `docker-compose.yml` adds `GMAIL_BACKFILL`.
**Employee upload (2026-11-22, branch `arpan/employee-dropbox`, uncommitted):** employees get **Upload a bill** in the sidebar (`/checks/upload`): drop a PDF → read → **Submit to AP** → lands in Checks; requester and department are forced to themselves on the server (`app/checks/upload/actions.ts`). Not clicked through in a browser yet. **Shared changes — Andrew please review:** new `invoice.upload` action in `core/authorize.ts` (employee + the four reviewer roles); this reverses "Employee is read-only" (2026-11-22). **Youssef:** `dashboard/checks.ts` adds `uploadOptions()`; `app/_lib/nav.ts` upload entry now includes the employee.

### 2 Extraction — Arpan
**Works (standalone, PR #11):** document type + extraction; each credit-note amount normalized independently (BUG-Arpan-03); missing line values have explicit warnings and zero confidence (BUG-Arpan-04). `fixtures/extraction/` contains real invoice, scan and credit-note runs plus safe fallbacks; replay tests check `ValidationInput` and `lineType`. Shared contracts unchanged.
**Stubbed:** readings not persisted; database-backed tax codes still await foundation. Captured documents are English; French parsing is unit-tested separately.
**Next:** persist `extraction_raw`; cache by sha256; swap development CSV adapters for DB context.
**Waiting on:** foundation for persistence. **Andrew / Youssef:** contract fixtures and raw replies are ready for the validation mapper and coding's `lineType` consumer (`src/contracts/__tests__/intake-fixtures.test.ts`).

### 3 Coding — Youssef
**Works end to end** (branch `dashboard-redesign`): suggestions persisted on Postgres (Andrew's `pipeline/coding.ts`) and shown on **Checks**: per-line account + department with confidence, reason and alternatives; accept / change with a note; bulk-accept high confidence; journal preview; the submit guard. Backtest 99.6% (never wrong at high).
**Stubbed:** no LLM fallback for lines with no evidence. **Next:** `reapprovalReasons` on edits after approval.
**Waiting on:** intake to capture the requester (Checks asks the clerk for it today).

### 4 Validation — Andrew
**Works (merged to main, PR #12):** every check in `src/server/features/validation/`. **On Postgres:** `loadDbContext`, `validateWithin`, and flags saved to `invoice_flags` via `syncFlags` (one row per `flagKey`, so human decisions survive re-runs). `overrideFlag` / `resolveFlag` need a note (also a DB CHECK) and are audited. The DB path reproduces the CSV run on all 56 incoming invoices.
**Input:** extraction's real output via `readingToValidationInput` (`src/server/pipeline/intake.ts`).
**Next:** `validateBankForRelease` for payments.
**Waiting on:** Katie (payments reading stored flags instead of `deps.ts`).

### 5 Duplicates — Arpan
**Works (uncommitted on `arpan/feature/duplicate-check`, 2026-11-21):** `src/server/features/duplicates/`: same file, same number after reformatting, number variants, same amount ≤ 7 days, already paid by employee card (merchant name → vendor), and `SPLIT_IF_NOT_DUPLICATE` beside same-number pairs. Runs in `analyse()` after validation and over history in the seed; incoming 5 flagged, history every same-number pair incl. live AP-00394/AP-00407, no monthly-fee false positives. **A person decides every one** on `/payments/duplicates` (void/close via `fire()`, or override with a note). 34 tests; `npm run duplicates:batch`.
**Also:** `npm run demo` runs the app on embedded PGlite (no Docker); `docker compose up -d` = db + setup + app + gmail-poller, run end to end 2026-11-21 (seeds 426 invoices, polls Gmail every 10 s as `ap_app`). DB image is `postgres:16-alpine` (the Debian `postgres:16` snapshot was corrupt on Arpan's Docker).
**Next / waiting on:** void or hold after approval (state machine, TODO P0); payments reading stored block flags at release (Katie); approvals routing on `SPLIT_IF_NOT_DUPLICATE` after "not a duplicate" (Youssef).
**Shared changes:** `contracts/audit.ts` + `invoice.duplicates_checked`; `db/client.ts` accepts `pglite:`; seed + `pipeline/ingest.ts`; validation exports (`approvalThresholdsFromPolicyRows` extracted, same behaviour); Duplicates tab in Katie's dashboard; Youssef's chaos test timeout 30 s.

### 6 Approvals — Youssef
**Works end to end** (branch `dashboard-redesign`, on Postgres): submit from Checks with a live **route preview** (`previewApproval`, the same input builder as `submitForApproval`); **Approvals** queue = `waitingOn` per person (delegates see "on behalf of"); decision page with acknowledgements; holds go back to review with a note (`releaseHold`); the Admin edits policies (new version row, `updatePolicy`) and puts approvers on leave with a delegate (`setUserAvailability`). Routing follows `approval_policies.csv` (team decision 2026-11-21).
**Stubbed:** `approvalAging` reminders; `reapprovalReasons` not yet called on edits.

### Dashboard (all roles) — Youssef
**Works** (branch `dashboard-redesign`, merged with main): one app for the five roles, one person each (Jordan Okafor, Dev Malhotra, Elise Tremblay, Marcus Webb, Hannah Lindqvist — `session/roster.ts`); they are the only sign-ins and the only requesters offered. Click-by-click demo, incl. a Claude-read upload: [`demo-script.md`](demo-script.md). 909 tests pass after merging main (`e4ecc52`). Home / Inbox / Checks (+ upload, manual entry) / Approvals / Payments / Vendors / Audit trail / People & policies / Demo controls. Runs with **no Docker**: without `DATABASE_URL` an in-process Postgres is built from the dataset at startup (`src/server/demo/`). Doc: [`architecture/dashboard.md`](architecture/dashboard.md); end-to-end flow test `src/server/dashboard/__tests__/flow.test.ts`.
**Changes in other people's code — please review:**
- **Andrew:** `core/authorize.ts` — checks open to `approver` + `finance_manager`; `audit.view` for all five roles, `audit.export` + `controller_admin`. Contracts: `audit.ts` + `user.status_changed`, `audit-view.ts` + optional `statuses`. `pipeline/approvals.ts`: shared `buildApprovalInput` (keeps `vendorConflicts`); new `pipeline/{manual-entry,documents,admin,payments}.ts`. Vendors screen calls `features/vendors`.
- **Katie:** payments stay her Postgres service; `pipeline/payments.ts` only adds the Admin release rule. `deps.ts`: only a fully approved plan approves a payee (review finding, fixed). Payments pages sit in the shared frame; upload moved to `/checks/upload` and saves through `ingestInvoice`.
- **Arpan:** `pipeline/intake.ts` stores intake's reason on emails the seed loaded; Duplicates is in the shared sidebar; `duplicates/__tests__/db.test.ts` now shows the refusal with the Auditor (managers may do checks).
- `@electric-sql/pglite` is a dependency; the quick demo (`npm run dev`, no `DATABASE_URL`) runs as `ap_app` like `npm run demo`.
**Bonus (branch `journal-export`):** Records → Journal export — approved bills + settled payments as a balanced CSV journal, Finance Manager + Admin only, never posted twice ([`journal-export.md`](architecture/journal-export.md)).
**Next:** real auth; uploads to object storage; live mailbox polling from the Inbox (Gmail connector exists as a script).

### 7 Payments — Katie
**Works (on the database since 2026-11-21, branch `Katie`; tested on PGlite):** schedule / release / cancel / retry / schedule again; release rules (P09–P11, approver / scheduler / requester can't release, active staff, verified bank, pending bank change, payee + amount = approved, FX re-check, blocking flags); simulated EFT with 9 failure reasons; urgency flags; bank change + second-person verify. Every action: `authorize()` first, then one transaction with `fire()` and its `withAction` audit rows. Reads approvals through `PostgresApprovalStore` and open `invoice_flags` (so Validation's "waiting on Katie" is done). Dashboard `/payments` reads and acts through it; `/payments-console` = simulated bank only (reset = `npm run db:reset`). Contract `src/contracts/payment.ts`, guide `docs/payment-data.md`, doc `docs/architecture/7-payments.md`.
**Stubbed:** money helpers (`money.ts`, TEMP: core/money); the stored-flag reader queries `invoice_flags` directly (validation exports none); bank changes stay inside payments until vendors exists. **Next:** open P1s in TODO (completed approvals at release, pay-date parsing, bank-account currency); manual click-through. **Waiting on:** Andrew (`validateBankForRelease`, an exported stored-flag reader, `.env.example` = BUG-Katie-03); vendors (no owner).
**Schema change:** `vendor_bank_accounts.currency` + a `closed` status (on main). **Run it:** `npm run demo` (built-in PGlite, no Docker; checked 2026-11-21: 8 payments pages, real data, 0 errors), or Docker Postgres (`npm run db:up`, `npm run db:reset`, `DATABASE_URL` in `.env`).

### 8 Audit + foundation — Andrew
**Works (merged to main via PR #12; follow-ups on `andrew-audit-db`; tested on PGlite and Docker Postgres 16):**
- **Schema + seed:** 22 tables; `npm run db:reset` loads the whole dataset, including a reconstructed history audit trail.
- **Append-only `audit_events`:** a trigger blocks edits for every role, and the `ap_app` role has no UPDATE/DELETE and cannot backdate.
- **Intake → DB:** `gmail:poll` and `intake:dataset` save every email through `ingestFromIntake`: bills validated, coded, audited, linked to a `documents` row (sha256); unreadable → `ManualEntry`; idempotent.
- **Pipeline:** `src/server/pipeline/` runs ingest → validation + coding → review → `submitForApproval` / `decideApproval` (Postgres `ApprovalStore`), each step audited in the same transaction.
- **Audit log** (`/audit`, `features/audit`): every event with before/after, control checks, export — **Auditor and Controller/Admin only** (product.md); the Auditor sees every invoice, in progress too.
- **Invoice records** (`/invoices`, `features/invoices`): read-only, scoped per the matrix's "View invoices" row (employee own, manager own dept, everyone else all); invoice PDFs follow the same scope.
- **Who did what** (`whoDidWhat`): requested → checked → approved → scheduled → released, on the audit page, the invoice record, and live on Checks / Approvals / Payments.

- **Demo + Docker (2026-11-22, PR to main from `andrew-audit-db`):** sixth role Employee (read-only, `invoice.submit` refused in `core/authorize.ts`); Admin **Reset demo data** (`src/server/demo/reset.ts`), the same baseline `docker compose up` builds on an empty database; BUG-Andrew-09 (Docker sign-in, Gmail PDFs, uploads volume, TZ). A fresh clone with no `.env.local` runs the full demo from `docker compose up -d`: [`running-with-docker.md`](running-with-docker.md).

- **2026-11-25 (`andrew-audit-db`):**
  - **CFO joins the demo cast:** Priya Raman signs in as **CFO**, the `controller_admin` with no manager (`isCfo`, `src/server/session/roles.ts`; picked in `roster.ts`). Same screens and server rights as the Admin; she releases what the Controller approved, so bills from $50k to $250k can now be paid. Over $250k nobody may release (P04 + P11): a talking point, kept strict.
  - **Search + Sort by** on Invoices and Audit trail (in the database, `orderFor` in `src/server/features/audit/list.ts`) and on Checks, Duplicates and Payments overview (in memory over the open queue, `src/server/dashboard/list-query.ts`). **Contract:** optional `sort` (`InvoiceSort`) on `AuditInvoiceListQuery`, additive.
  - **Fixes:** policy descriptions now restate the edited threshold (BUG-Andrew-10); the Admin/CFO get the Release button on a payment's page (BUG-Andrew-11) and the duplicate decisions (BUG-Andrew-12).
  - **Shared UI touched:** `app/_lib/nav.ts`, `app/payments/{page,to-release/page,[invoiceId]/page,duplicates/page}.tsx`, `app/payments/_lib/access.ts`, `FilterBar.tsx` (Katie, Arpan: please skim).

**Stubbed:** uncertain scans make no invoice yet (Arpan's TODO); the demo DB has history only, so live chains show once invoices go through Checks.
**Next:** Supabase deploy.
**Waiting on:** team decisions: historical `rejected` → `Voided`, schema-merge owner (`docs/architecture/8-audit.md`); whether duplicate decisions get their own `duplicate.decide` permission (BUG-Andrew-13); a `pg_trgm` index for search at 100× (schema).
**Contract + core + schema change:** new `src/contracts/{actor,audit,audit-view}.ts`, `src/server/core/`, `src/server/db/`. Affects Youssef (coding and approvals on the DB through his public API) and Katie (payments tables, audit names).

### 9 Vendors — Andrew (server side)
**Works (on `andrew-audit-db` at `114cc24`, merged with main; tested on PGlite, the embedded demo DB and Docker Postgres):** `src/server/features/vendors/` — vendor list + detail (`vendor.view`: clerk, FM, controller, auditor read-only), onboard (duplicate check, prefill from an unknown-vendor invoice), approve by a second person, hold / lift hold, bank change request → verify by a second person / reject. Each change re-checks the vendor's open invoices, so `VENDOR_*` / `BANK_*` flags follow it. `vendorConflicts` feeds approvals.
**Stubbed:** no screens (dashboard owner: `src/contracts/vendor.ts`, `fixtures/vendors/`).
**Next:** screens (dashboard owner). Bank changes: payments (Katie) and vendors write the same `vendor_bank_accounts` rows the same way — verified both directions on Docker; the UI may call either.
**Contract + core change:** new `src/contracts/vendor.ts`; 5 new `vendor.*` actions in `core/authorize.ts`; approvals now receives `conflicts`. No schema change, no migration. Affects Katie (bank changes) and Youssef (conflicts reach his router).

## Watch out

- Rules in `docs/rules/` do not auto-load; read the one for the files you touch.
- No Docker? `npm run demo` (embedded Postgres in `.data/pglite`). Stop other dev servers first: one process per folder.
- The state machine in `docs/explainers/brim-ap-diagrams.md` has open gaps (credit notes, release-time holds) — see `TODO.md` P0.
