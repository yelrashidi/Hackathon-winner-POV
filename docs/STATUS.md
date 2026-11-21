# Brim AP — status

**As of:** 2026-11-20 · `4860f5b` · docs set up, no code yet.

Printed at the start of every session. Orient from this, not from `TODO.md`. **Each owner edits
only their own section** (four people editing one paragraph is a merge conflict per commit);
the top block is updated by whoever finishes a shared piece.

## Team

| Owner | Features | Also owns |
|---|---|---|
| Arpan | _features to fill_ | |
| Youssef | _features to fill_ | |
| Andrew | _features to fill_ | |
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

### 4 Validation — _Arpan / Youssef / Andrew / Katie_
Not started.

### 5 Duplicates — _Arpan / Youssef / Andrew / Katie_
Not started.

### 6 Approvals — _Arpan / Youssef / Andrew / Katie_
Not started.

### 7 Payments — _Arpan / Youssef / Andrew / Katie_
Not started.

### 8 Audit + foundation — _Arpan / Youssef / Andrew / Katie_
Not started.

### 9 Vendors — _Arpan / Youssef / Andrew / Katie_
Not started.

## Watch out

- Rules in `docs/rules/` do not auto-load; read the one for the files you touch.
- The state machine in `docs/explainers/brim-ap-diagrams.md` has open gaps (credit notes, release-time holds) — see `TODO.md` P0.
