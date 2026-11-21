# Architecture overview

**Code as of:** never — written before the first line of code; reconcile once the foundation lands.

## The pipeline

```
email / upload
   │  1 intake        inbox_messages, documents (PDF stored once, sha256)
   ▼
 2 extraction         → ExtractedInvoice (contract)            ─┐
   ▼                                                            │ invoice status: Received → InReview
 analysis pass (one shared vendor context, re-run on every edit) │
   3 coding           → CodingSuggestion[] per line              │
   4 validation       → Flag[]                                   │
   5 duplicates       → Flag[] (with related invoice / card txn) ─┘
   ▼
 6 approvals          → ApprovalStep[] from policy             InReview → PendingApproval → Approved
   ▼
 7 payments           → Payment (simulated EFT)                Approved → PaymentScheduled → Paid
   ▼
 8 audit              every arrow above wrote an audit_event in the same transaction
```

State machine and dependency graph: [`../explainers/brim-ap-diagrams.md`](../explainers/brim-ap-diagrams.md).

## How the stages hand off: contracts + database + fixtures

The idea of *each stage outputs JSON and the PDF, the next stage reads it* is right about one
thing: **stages must agree on a shape, and nobody should wait for upstream code to exist.** We
keep that and drop the file-passing:

1. **The shape is a Zod schema in `src/contracts/`** (`ExtractedInvoice`, `CodingSuggestion`,
   `Flag`, `ApprovalPlan`, …). Each stage is a function `(input: A, ctx) => B` with both sides
   typed. Change a schema and TypeScript shows every consumer that breaks.
2. **Results persist to Postgres, not to JSON files.** The workflow loops back: an edit reruns
   analysis, a rejection returns to review, a material edit voids approvals. Permissions,
   concurrent users and an audit query across everything need one store. The PDF is stored once
   (`documents`) and referenced by id, never copied between stages.
3. **`fixtures/<stage>/*.json` are frozen outputs of each stage**, checked in. The coding owner
   builds against `fixtures/extraction/*.json` on day one, long before extraction works. When a
   real stage lands, regenerate its fixtures and re-run downstream tests.
4. **Raw LLM output is kept** (`invoices.extraction_raw jsonb`) so a bad extraction can be
   debugged and re-parsed without paying for another call.

So the JSON still exists — as the contract and the test fixtures — but the database is the
runtime hand-off. Rules for changing a contract: [`../rules/contracts.md`](../rules/contracts.md).

## Foundation — built first, together (feature 8 is mostly here)

| Piece | What it guarantees |
|---|---|
| `db/schema` + seed from `brim_ap_dataset/brim_ap_dataset/data/*.csv` | everyone works on the same tables and the real dataset from hour one |
| `core/fire.ts` | the only way to change invoice status: legal transition + guard + audit event, one transaction |
| `core/authorize.ts` | `authorize(actor, action, resource)`; separation of duties lives here |
| `core/audit.ts` | `emit(tx, event)` — append-only `audit_events` |
| `core/fx.ts`, `core/money.ts` | USD→CAD by invoice date; cents arithmetic; used by validation, approvals and payments |
| session + role switcher | a real server session per seeded user |

## Deployment

**Recommended: one Next.js app on Vercel + Supabase used as plain Postgres and file storage.**

- The "TypeScript backend" is `src/server/`, called from Next route handlers and server
  actions — one repo, one deploy, no CORS, still a real API judges can hit with the wrong role.
- Supabase gives Postgres and a Storage bucket for invoice PDFs with no ops. Connect with the
  **pooled** connection string from serverless functions ([`../rules/db.md`](../rules/db.md)).
- **Do not use Supabase Auth or row-level security for permissions.** Keep authorization in
  `authorize()`: one place, unit-testable, easy to explain in the Q&A. A seeded-user session is
  enough for the demo.
- **Extraction of a batch is not a web request.** Fifty LLM calls can exceed a serverless
  function's time limit. Run the batch from `scripts/` (or a queue table drained in small
  chunks), and keep the per-upload path to one invoice.

**Alternative if you want a separate long-running backend** (Express/Fastify/Hono): Railway runs
the Node service and Postgres in one project with no function time limits. Costs a second deploy
target and CORS.

**Local:** Postgres in Docker, one per developer. Four people migrating one shared dev database
in parallel is how hours disappear.

## What breaks at 100× (5,000 invoices a month) — keep this current

| Area | Naive version | What we would do |
|---|---|---|
| Duplicates | compare every invoice to every other | block by vendor + normalized number + amount bucket; trigram index on invoice number |
| Extraction | one synchronous LLM call per upload | queue + worker pool, rate-limited; cache by document sha256 |
| Coding | scan all history per line | precomputed vendor → (account, dept) frequency table |
| Audit | one table forever | partition by month; it is append-only so this is cheap |
| Approvals | recompute routing on every page load | store the plan per invoice version |
