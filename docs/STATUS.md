# Brim AP — status

**As of:** 2026-11-20 · `4860f5b` · docs set up, no code yet.

Printed at the start of every session. Orient from this, not from `TODO.md`. **Each owner edits
only their own section** (four people editing one paragraph is a merge conflict per commit);
the top block is updated by whoever finishes a shared piece.

## Team

| Owner | Features | Also owns |
|---|---|---|
| Arpan | 1 Intake, 2 Extraction | |
| Youssef | 3 Coding, 6 Approvals, dashboard (all roles) | |
| Andrew | 4 Validation, 8 Audit + foundation (schema, `core/`, `src/server/pipeline/`) | |
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
**Stubbed:** nothing is persisted (cursor in `.intake/`); vendor domains and tax codes read from the CSVs.
**Next:** step 3 — intake tables + PDF store + `saveIntakeResult()`; uncertain documents as their own dashboard item (see `TODO.md` § 1–2).
**Waiting on:** foundation (schema owner, `fire()`, `authorize()`, `audit.emit`) — or agreement that Arpan writes the intake tables first.

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

### 5 Duplicates — _Arpan / Youssef / Andrew / Katie_
Not started.

### 6 Approvals — Youssef
**Works end to end** (branch `dashboard-redesign`, on Postgres): submit from Checks with a live **route preview** (`previewApproval`, the same input builder as `submitForApproval`); **Approvals** queue = `waitingOn` per person (delegates see "on behalf of"); decision page with acknowledgements; holds go back to review with a note (`releaseHold`); the Admin edits policies (new version row, `updatePolicy`) and puts approvers on leave with a delegate (`setUserAvailability`). Routing follows `approval_policies.csv` (team decision 2026-11-21).
**Stubbed:** `approvalAging` reminders; `reapprovalReasons` not yet called on edits.

### Dashboard (all roles) — Youssef
**Works** (branch `dashboard-redesign`, not merged): one app for the five roles, one person each (Jordan Okafor, Dev Malhotra, Elise Tremblay, Marcus Webb, Hannah Lindqvist — `session/roster.ts`); they are the only sign-ins and the only requesters offered. Click-by-click demo: [`demo-script.md`](demo-script.md). Home / Inbox / Checks (+ upload, manual entry) / Approvals / Payments / Vendors / Audit trail / People & policies / Demo controls. Runs with **no Docker**: without `DATABASE_URL` an in-process Postgres is built from the dataset at startup (`src/server/demo/`). Doc: [`architecture/dashboard.md`](architecture/dashboard.md). 796 tests, including an end-to-end flow test (`src/server/dashboard/__tests__/flow.test.ts`).
**Changes in other people's code — please review:**
- **Andrew:** `core/authorize.ts` — checks open to `approver` + `finance_manager`; `audit.view` for all five roles, `audit.export` + `controller_admin` (tests updated). Contracts: `audit.ts` + `user.status_changed`, `audit-view.ts` + optional `statuses`. `pipeline/approvals.ts` refactored (shared `buildApprovalInput`), new `pipeline/{payments,manual-entry,documents,admin}.ts`.
- **Katie:** payments now run on Postgres through `pipeline/payments.ts` (her rules untouched; `fake-data/store.ts` gained a per-request state, `deps.ts` reads approval facts from it). Payments pages sit in the shared frame; the Admin only releases what the Finance Manager can't; reset is Admin-only. Upload moved to `/checks/upload` and saves through `ingestInvoice`.
- **Arpan:** `pipeline/intake.ts` now stores intake's verdict + reason on emails the seed already loaded.
- `@electric-sql/pglite` moved to dependencies; `next.config.ts` lists it in `serverExternalPackages`.
**Next:** duplicates screen when feature 5 lands; real auth; uploads to object storage.

### 7 Payments — Katie
**Works (in memory, on the dataset; merged to main 2026-11-21, `b69ce5d`):** schedule / release / cancel / retry / schedule again; release rules (P09–P11, approver / scheduler / requester can't release, active staff, verified bank, pending bank change, payee + amount = approved, FX re-check, blocking flags); simulated EFT with 9 failure reasons; urgency flags; bank change + second-person verify; audit events. Dashboard `/payments` reads and acts through it; `/payments-console` = simulated bank + reset. Contract `src/contracts/payment.ts`, guide `docs/payment-data.md`, doc `docs/architecture/7-payments.md`.
**Stubbed:** other features behind `deps.ts` (`// TEMP:`), owners in `docs/payment-assumptions.md`; data in memory. **Next:** swap adapters as teammates land; UI polish. **Waiting on:** schema, `fire()`, `authorize()`, audit (no owner); Andrew (stored flags, `validateBankForRelease`); duplicates + vendors (no owner); Youssef (approval flow filling his store).
**Schema change:** `vendor_bank_accounts.currency` + a `closed` status.

### 8 Audit + foundation — Andrew
**Works (merged to main via PR #12; follow-ups on `andrew-audit-db`; tested on PGlite and Docker Postgres 16):**
- **Schema + seed:** 22 tables; `npm run db:reset` loads the whole dataset, including a reconstructed history audit trail.
- **Append-only `audit_events`:** a trigger blocks edits for every role, and the `ap_app` role has no UPDATE/DELETE and cannot backdate.
- **Intake → DB:** `gmail:poll` and `intake:dataset` save every email through `ingestFromIntake`: bills validated, coded, audited, linked to a `documents` row (sha256); unreadable → `ManualEntry`; idempotent.
- **Pipeline:** `src/server/pipeline/` runs ingest → validation + coding → review → `submitForApproval` / `decideApproval` (Postgres `ApprovalStore`), each step audited in the same transaction.
- **Auditor dashboard services:** `listAuditInvoices`, `getInvoiceAuditDetail` (incl. control checks) and `exportAuditCsv`, auditor-only, with fixtures in `fixtures/audit/`.

**Stubbed:** no `app/audit` pages yet; payments (7) not on the DB; uncertain scans make no invoice yet (Arpan's TODO).
**Next:** the auditor pages (dashboard owner); Supabase deploy.
**Waiting on:** team decisions: Controller audit access, historical `rejected` → `Voided`, schema-merge owner (`docs/architecture/8-audit.md`).
**Contract + core + schema change:** new `src/contracts/{actor,audit,audit-view}.ts`, `src/server/core/`, `src/server/db/`. Affects Youssef (coding and approvals on the DB through his public API) and Katie (payments tables, audit names).

### 9 Vendors — _Arpan / Youssef / Andrew / Katie_
Not started.

## Watch out

- Rules in `docs/rules/` do not auto-load; read the one for the files you touch.
- The state machine in `docs/explainers/brim-ap-diagrams.md` has open gaps (credit notes, release-time holds) — see `TODO.md` P0.
