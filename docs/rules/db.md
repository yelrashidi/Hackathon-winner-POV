---
description: Schema and migrations — one merger, never edit what is on main, seed vs migration
paths:
  - "src/server/db/**"
  - "scripts/seed*"
  - "brim_ap_dataset/**"
---

# Database

- **One person merges schema changes** (named in `STATUS.md`). Four people generating migrations
  in parallel produce conflicting migration files that git merges silently. Propose your table
  change in your PR; the schema owner sequences it.
- **A migration already on `main` is never edited.** Write a new one. Your own unpushed migration
  stays editable — and then reset your local database.
- **The dataset folder is read-only input.** Its CSV column names are not our column names;
  the seed maps them (`vendor_invoice_number` → `invoice_number`, `total_cad` → `total_cad_cents`).
  Its status values (`pending_approval`, `approved`, `scheduled`, `paid`, `rejected`) map onto our state machine.
- **Migrations hold structure; `scripts/seed.ts` holds data.** The dataset loads through the seed,
  so `npm run db:reset` gives everyone the same Harborline state.
- **Read [`data-model.md`](../architecture/data-model.md) before adding a table** — the column you
  want may already exist under another name (`total_cad_cents`, `invoice_number_norm`).
- **Money columns are `bigint` cents** (`*_cents`); rates are `numeric` ([`money-and-tax.md`](money-and-tax.md)).
- **`audit_events` is append-only.** No update or delete path, in code or migration.
- **Write audit rows only through `core/audit.ts` (`withAction` / `emit`).** A plain Drizzle insert lists `id` and `occurred_at`, which the app role may not set, so it fails with "permission denied".
- **Deployed on Supabase: use the pooled connection string** from serverless functions. The direct
  connection runs out of connections under a handful of concurrent requests. Migrations use the direct one.
- **A test that picks "the first row" says which one**: `ORDER BY` plus a filter for what it means (e.g. `source <> 'historical'`). Heap order changes whenever the seed writes more rows (BUG-Arpan-05).
- **An embedded PGlite folder (`DATABASE_URL=pglite:…`, `npm run demo`) has no lock**: only one process may open it; two corrupt it. `getDb()` keeps one instance per process on `globalThis`.
