# Brim AP — status

**As of:** 2026-11-20 · `4860f5b` · docs set up, no code yet.

Printed at the start of every session. Orient from this, not from `TODO.md`. **Each owner edits
only their own section** (four people editing one paragraph is a merge conflict per commit);
the top block is updated by whoever finishes a shared piece.

## Team

| Owner | Features | Also owns |
|---|---|---|
| Arpan | _features to fill_ | |
| Youssef | 6 Approvals, 7 Payments | |
| Andrew | _features to fill_ | |
| Youssef | _features to fill_ | |
| Andrew | 4 Validation | |
| Katie | _features to fill_ | |
| shared | foundation (`core/`) | schema merges: _name_ |

## Now (shared, in order)

1. **Kickoff decisions** (below) — 30 minutes, before any code.
2. **Foundation** — schema + seed, `fire()`, `authorize()`, audit emitter, fx/money, role-switch session. Everyone blocks on this; pair on it.
3. **Contracts + first fixtures** for every stage in `src/contracts/` and `fixtures/`.
4. **Thin end-to-end path** — one invoice from upload to `Paid` with every stage stubbed, then replace stubs.
5. **Golden set** — 10–15 incoming invoices with expected flags and route; `npm run eval`.

## Decisions

| Decision | State |
|---|---|
| Backend inside Next.js (`src/server/`) vs separate Node server | **open** — recommended: inside Next |
| Deploy: Vercel + Supabase (Postgres + Storage) vs Railway | **open** — recommended: Vercel + Supabase |
| ORM / query layer (Drizzle, Prisma, Kysely) | **open** — recommended: Drizzle (SQL-shaped, easy to explain) |
| LLM provider for classification / extraction | **open** |
| Money as integer cents | proposed |
| Auth: seeded users + role switcher, server session | proposed |
| Feature 9 (vendors) owner | **open** — required feature, see `product.md` |

## Per feature

### 1 Intake — _Arpan / Youssef / Andrew / Katie_
Not started.

### 2 Extraction — _Arpan / Youssef / Andrew / Katie_
Not started.

### 3 Coding — _Arpan / Youssef / Andrew / Katie_
Not started.

### 4 Validation — Andrew
**Works (standalone, uncommitted on `andrew`):** pure engine + every check in `src/server/features/validation/` (vendor, bank, PO, contract, tax vs delivery province, arithmetic, dates, FX, splits); 264 tests; all 56 incoming invoices raise exactly their hand-written expected flags; history replay blocks only the 3 real tax errors. `npm test` · `npm run validate:batch` · `npm run validate:history`.
**Stubbed:** input is our assumed extraction shape (`src/contracts/validation.ts`, **contract:**); reference data loads from the CSVs, not the DB; flags are returned, not persisted.
**Next:** DB context loader, persist to `invoice_flags` + override endpoint, mapper from extraction's real contract, `validateBankForRelease` for payments.
**Waiting on:** foundation (schema, `fire()`, `authorize()`); extraction owner's contract; Youssef — `src/contracts/flag.ts` copied verbatim from `origin/Youssef`, `PO_OVER_BALANCE` / `SPLIT_INVOICE_SUSPECTED` + `evidence.combinedCadCents` emitted as his approvals expects.

### 5 Duplicates — _Arpan / Youssef / Andrew / Katie_
Not started.

### 6 Approvals — Youssef
**Works** (tested): routing from `approval_policies` P01–P13 with delegation, escalation and separation of duties; the approve/reject gate `checkDecision`; re-approval on edits; aging; saving and loading plans and decisions (`saveApprovalPlan`, `getApprovalPlans`, `getCurrentApprovalPlan`, `saveDecision`). 137 tests; fixtures in `fixtures/approvals/`.
**Stubbed:** the store is in-memory (`// TEMP: db`) until the schema lands; not wired to `fire()`, `authorize()`, an API route or a screen yet. Tests need `zod` + `vitest` in `package.json`.
**Next:** approvals API route + approver queue screen once the foundation lands; then 7 Payments.
**Waiting on:** foundation (schema — `approval_plans` proposal in `6-approvals.md`, `fire`, `authorize`, session); validation (`PO_OVER_BALANCE`, `SPLIT_INVOICE_SUSPECTED.combinedCadCents`); vendors (`conflicts`). Contract change in `src/contracts/` — see [`6-approvals-edge-cases.md`](architecture/6-approvals-edge-cases.md) §13.

### 7 Payments — Youssef
Not started. Builds on approvals: P11 via `approversOf(...allPlans)`, and pay no more than `plan.basis` to no other payee.

### 8 Audit + foundation — _Arpan / Youssef / Andrew / Katie_
Not started.

### 9 Vendors — _Arpan / Youssef / Andrew / Katie_
Not started.

## Watch out

- Rules in `docs/rules/` do not auto-load; read the one for the files you touch.
- The state machine in `docs/explainers/brim-ap-diagrams.md` has open gaps (credit notes, release-time holds) — see `TODO.md` P0.
