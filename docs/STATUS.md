# Brim AP — status

**As of:** 2026-11-20 · `4860f5b` · docs set up, no code yet.

Printed at the start of every session. Orient from this, not from `TODO.md`. **Each owner edits
only their own section** (four people editing one paragraph is a merge conflict per commit);
the top block is updated by whoever finishes a shared piece.

## Team

| Owner | Features | Also owns |
|---|---|---|
| Arpan | 1 Intake, 2 Extraction, 5 Duplicates | |
| Youssef | 3 Coding, 6 Approvals | |
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
**Stubbed:** nothing is persisted (cursor in `.intake/`); vendor domains and tax codes read from the CSVs.
**Next:** step 3 — intake tables + PDF store + `saveIntakeResult()`; uncertain documents as their own dashboard item (see `TODO.md` § 1–2).
**Waiting on:** foundation (schema owner, `fire()`, `authorize()`, `audit.emit`) — or agreement that Arpan writes the intake tables first.

### 2 Extraction — Arpan
**Works (standalone, PR #11):** document type + extraction; each credit-note amount normalized independently (BUG-Arpan-03); missing line values have explicit warnings and zero confidence (BUG-Arpan-04). `fixtures/extraction/` contains real invoice, scan and credit-note runs plus safe fallbacks; replay tests check `ValidationInput` and `lineType`. Shared contracts unchanged.
**Stubbed:** readings not persisted; database-backed tax codes still await foundation. Captured documents are English; French parsing is unit-tested separately.
**Next:** persist `extraction_raw`; cache by sha256; swap development CSV adapters for DB context.
**Waiting on:** foundation for persistence. **Andrew / Youssef:** contract fixtures and raw replies are ready for the validation mapper and coding's `lineType` consumer (`src/contracts/__tests__/intake-fixtures.test.ts`).

### 3 Coding — Youssef
**Works** (pure, tested on branch `step-3`): per-line GL account + department suggestions with confidence and reason; journal preview (recoverable tax → 1160/1165, BC PST into goods lines, AP 2100); server-side coding gate, bulk-accept, submit guard (`CODING_NOT_CONFIRMED`), learning loop. Backtest 99.6% (never wrong at high); fixtures in `fixtures/coding/`.
**Stubbed:** no persistence to `invoice_lines`, no review screen yet; history index built in memory from the dataset.
**Next:** wire into the analysis pass after validation's `matchVendor`; review screen with bulk-accept.
**Waiting on:** intake to capture the **requester** (department is 100% right with it, 82.8% without; none of the 56 incoming invoices has one); extraction to keep `lineType`; LLM provider decision (optional fallback). New contract: `src/contracts/coding.ts`.

### 4 Validation — Andrew
**Works (merged to main, PR #12):** every check in `src/server/features/validation/`. **On Postgres:** `loadDbContext`, `validateWithin`, and flags saved to `invoice_flags` via `syncFlags` (one row per `flagKey`, so human decisions survive re-runs). `overrideFlag` / `resolveFlag` need a note (also a DB CHECK) and are audited. The DB path reproduces the CSV run on all 56 incoming invoices.
**Input:** extraction's real output via `readingToValidationInput` (`src/server/pipeline/intake.ts`).
**Next:** `validateBankForRelease` for payments.
**Waiting on:** Katie (payments reading stored flags instead of `deps.ts`).

### 5 Duplicates — Arpan
**Works (uncommitted on `arpan/feature/duplicate-check`, 2026-11-21):** `src/server/features/duplicates/`: same file, same number after reformatting, number variants, same amount ≤ 7 days, already paid by employee card (merchant name → vendor), and `SPLIT_IF_NOT_DUPLICATE` beside same-number pairs. Runs in `analyse()` after validation and over history in the seed; incoming 5 flagged, history every same-number pair incl. live AP-00394/AP-00407, no monthly-fee false positives. **A person decides every one** on `/payments/duplicates` (void/close via `fire()`, or override with a note). 34 tests; `npm run duplicates:batch`.
**Also:** `npm run demo` runs the app on embedded PGlite (no Docker); `docker compose up -d` = db + setup + app (built, not run end to end — Docker disk on full C:).
**Next / waiting on:** void or hold after approval (state machine, TODO P0); payments reading stored block flags at release (Katie); approvals routing on `SPLIT_IF_NOT_DUPLICATE` after "not a duplicate" (Youssef).
**Shared changes:** `contracts/audit.ts` + `invoice.duplicates_checked`; `db/client.ts` accepts `pglite:`; seed + `pipeline/ingest.ts`; validation exports (`approvalThresholdsFromPolicyRows` extracted, same behaviour); Duplicates tab in Katie's dashboard; Youssef's chaos test timeout 30 s.

### 6 Approvals — Youssef
**Works** (tested): routing from `approval_policies` P01–P13 with delegation, escalation and separation of duties; the approve/reject gate `checkDecision`; re-approval on edits; aging; saving and loading plans and decisions (`saveApprovalPlan`, `getApprovalPlans`, `getCurrentApprovalPlan`, `saveDecision`). 137 tests; fixtures in `fixtures/approvals/`.
**Stubbed:** the store is in-memory (`// TEMP: db`) until the schema lands; not wired to `fire()`, `authorize()`, an API route or a screen yet. Payments (Katie) already reads it through `getApprovalPlans` / `approversOf` / `basis`.
**Next:** approvals API route + approver queue screen once the foundation lands; make the in-memory store one shared copy together with Katie's seed (see TODO).
**Waiting on:** foundation (schema — `approval_plans` proposal in `6-approvals.md`, `fire`, `authorize`, session); validation (`PO_OVER_BALANCE`, `SPLIT_INVOICE_SUSPECTED.combinedCadCents`); vendors (`conflicts`). Contract change in `src/contracts/` — see [`6-approvals-edge-cases.md`](architecture/6-approvals-edge-cases.md) §13.

### 7 Payments — Katie
**Works (on the database since 2026-11-21, branch `Katie`; tested on PGlite):** schedule / release / cancel / retry / schedule again; release rules (P09–P11, approver / scheduler / requester can't release, active staff, verified bank, pending bank change, payee + amount = approved, FX re-check, blocking flags); simulated EFT with 9 failure reasons; urgency flags; bank change + second-person verify. Every action: `authorize()` first, then one transaction with `fire()` and its `withAction` audit rows. Reads approvals through `PostgresApprovalStore` and open `invoice_flags` (so Validation's "waiting on Katie" is done). Dashboard `/payments` reads and acts through it; `/payments-console` = simulated bank only (reset = `npm run db:reset`). Contract `src/contracts/payment.ts`, guide `docs/payment-data.md`, doc `docs/architecture/7-payments.md`.
**Stubbed:** money helpers (`money.ts`, TEMP: core/money); the stored-flag reader queries `invoice_flags` directly (validation exports none); bank changes stay inside payments until vendors exists. **Next:** open P1s in TODO (completed approvals at release, pay-date parsing, bank-account currency); manual click-through. **Waiting on:** Andrew (`validateBankForRelease`, an exported stored-flag reader, `.env.example` = BUG-Katie-03); vendors (no owner).
**Schema change:** `vendor_bank_accounts.currency` + a `closed` status (on main). **Running the dashboard now needs Postgres:** `npm run db:up`, `npm run db:reset`, `DATABASE_URL` in `.env`.

### 8 Audit + foundation — Andrew
**Works (merged to main via PR #12; follow-ups on `andrew-audit-db`; tested on PGlite and Docker Postgres 16):**
- **Schema + seed:** 22 tables; `npm run db:reset` loads the whole dataset, including a reconstructed history audit trail.
- **Append-only `audit_events`:** a trigger blocks edits for every role, and the `ap_app` role has no UPDATE/DELETE and cannot backdate.
- **Intake → DB:** `gmail:poll` and `intake:dataset` save every email through `ingestFromIntake`: bills validated, coded, audited, linked to a `documents` row (sha256); unreadable → `ManualEntry`; idempotent.
- **Pipeline:** `src/server/pipeline/` runs ingest → validation + coding → review → `submitForApproval` / `decideApproval` (Postgres `ApprovalStore`), each step audited in the same transaction.
- **Auditor dashboard services:** `listAuditInvoices`, `getInvoiceAuditDetail` (incl. control checks) and `exportAuditCsv`, auditor-only, with fixtures in `fixtures/audit/`.

**Stubbed:** no `app/audit` pages yet; uncertain scans make no invoice yet (Arpan's TODO). Payments (7) is on the DB since PR #15 (Katie).
**Next:** the auditor pages (dashboard owner); Supabase deploy.
**Waiting on:** team decisions: Controller audit access, historical `rejected` → `Voided`, schema-merge owner (`docs/architecture/8-audit.md`).
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
