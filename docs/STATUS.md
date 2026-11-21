# Brim AP — status

**As of:** 2026-11-20 · `4860f5b` · docs set up, no code yet.

Printed at the start of every session. Orient from this, not from `TODO.md`. **Each owner edits
only their own section** (four people editing one paragraph is a merge conflict per commit);
the top block is updated by whoever finishes a shared piece.

## Team

| Owner | Features | Also owns |
|---|---|---|
| Arpan | 1 Intake, 2 Extraction | |
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
| LLM provider for classification / extraction | **Claude** (`claude-opus-5-5`, `@anthropic-ai/sdk` 1.4.0) — used by intake + extraction since 2026-11-21 (Arpan); confirm at kickoff |
| Money as integer cents | proposed |
| Auth: seeded users + role switcher, server session | proposed |
| Feature 9 (vendors) owner | **open** — required feature, see `product.md` |

## Per feature

### 1 Intake — Arpan
**Works (standalone, uncommitted on `arpan/feature/gmail-connector`):** Gmail connector (OAuth `gmail.readonly`, history-id polling) and dataset `emails.json` adapter → one `InboxMessage`; classifier: email rules for no-document mail, every document read by extraction, only invoices/credit notes become bills, nothing dropped. `npm run gmail:poll -- --watch 30` · `npm run intake:dataset [-- --no-llm]`. Setup: `docs/architecture/1-intake.md#gmail-setup`.
**Stubbed:** nothing is persisted (cursor in `.intake/`); vendor domains and tax codes read from the CSVs.
**Next:** step 3 — intake tables + PDF store + `saveIntakeResult()`; uncertain documents as their own dashboard item (see `TODO.md` § 1–2).
**Waiting on:** foundation (schema owner, `fire()`, `authorize()`, `audit.emit`) — or agreement that Arpan writes the intake tables first.

### 2 Extraction — Arpan
**Works (standalone, uncommitted):** one read per document → `DocumentReading` / `ExtractedDocument` (**contract:** `src/contracts/extraction.ts`, field names = `ValidationInput`). PDF text layer locally → document-type rules → one Claude read (text, or the image for scans) → deterministic normalizer (printed amounts → cents, credit notes negative). Live: 5/5 sample documents correct incl. French, scan, credit note; receipt/quote/terms PDFs not drafted.
**Stubbed:** readings not persisted; no fixtures yet.
**Next:** fixtures from real runs in `fixtures/extraction/`; persist `extraction_raw`; cache by sha256.
**Waiting on:** nothing. **Tell Andrew:** his extraction → `ValidationInput` mapper can be written against `ExtractedDocument` now.

### 3 Coding — _Arpan / Youssef / Andrew / Katie_
Not started.

### 4 Validation — Andrew
**Works (standalone, uncommitted on `andrew`):** pure engine + every check in `src/server/features/validation/` (vendor, bank, PO, contract, tax vs delivery province, arithmetic, dates, FX, splits); 264 tests; all 56 incoming invoices raise exactly their hand-written expected flags; history replay blocks only the 3 real tax errors. `npm test` · `npm run validate:batch` · `npm run validate:history`.
**Stubbed:** input is our assumed extraction shape (`src/contracts/validation.ts`, **contract:**); reference data loads from the CSVs, not the DB; flags are returned, not persisted.
**Next:** DB context loader, persist to `invoice_flags` + override endpoint, mapper from extraction's real contract, `validateBankForRelease` for payments.
**Waiting on:** foundation (schema, `fire()`, `authorize()`); extraction owner's contract; Youssef — `src/contracts/flag.ts` copied verbatim from `origin/Youssef`, `PO_OVER_BALANCE` / `SPLIT_INVOICE_SUSPECTED` + `evidence.combinedCadCents` emitted as his approvals expects.

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
