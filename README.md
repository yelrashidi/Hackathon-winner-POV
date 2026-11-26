# Brim Hackathon challenge CodeJam 16 2026

Accounts payable (AP) automation for the Brim hackathon. A supplier invoice for the fictional
Harborline Logistics goes **inbox → read → code → check → approve → pay → audit trail**, with one
screen per job and six roles. All data is synthetic (`brim_ap_dataset/`) and payments are
simulated: no real money moves.

The app runs end to end, per role. Current progress, owners and open decisions: [`docs/STATUS.md`](docs/STATUS.md).

## Quick start

Each way ends at http://localhost:3000, where you pick who you are. The no-Docker ways need Node 22+.

**1. Fastest: in-memory demo, no Docker.** With no `DATABASE_URL`, the app builds an in-process
Postgres from the dataset on the first request (~5 s): 10 months of history plus the AP inbox run
through intake. A restart, or **Demo controls → Reset demo data** (Admin), starts again.

```bash
npm install
```

```bash
npm run dev
```

If a `.env` or `.env.local` sets `DATABASE_URL`, `npm run dev` uses that database instead.

**2. Demo that keeps its data, no Docker.** An embedded Postgres (PGlite) in `.data/pglite`,
created, migrated and seeded on the first run (about a minute), reused afterwards. Stop any other
`npm run dev` first (one process per folder).

```bash
npm run demo
```

**3. Everything in Docker.** Postgres, migrations + first-time seed, the app (frontend + backend)
and the Gmail poller, one command. No Node or API keys needed. Data survives restarts. Step by
step, with troubleshooting: [`docs/running-with-docker.md`](docs/running-with-docker.md).

```bash
docker compose up -d
```

| Then | Command |
| --- | --- |
| `npm run demo`: start from a fresh database (its Reset button is off) | `npm run demo -- --reset` |
| Docker: rebuild after code changes | `docker compose up -d --build` |
| Docker: watch new mail being read and saved | `docker compose logs -f gmail-poller` |
| Docker: stop and wipe the database (next `up` re-seeds) | `docker compose down -v`, or **Demo controls → Reset demo data** (Admin) |

**Developing against Docker Postgres:** start the database, copy the local connection strings, reset, run.

```bash
npm run db:up
```

```bash
cp .env.example .env
```

```bash
npm run db:reset
```

```bash
npm run dev
```

### Settings

`.env*` is git-ignored (except `.env.example`); never commit keys.

| Setting | Where | Effect |
| --- | --- | --- |
| `DATABASE_URL` | `.env` (from [`.env.example`](.env.example)) | The app's Postgres, as the restricted `ap_app` login. Unset → the in-memory demo |
| `DATABASE_URL_ADMIN` | `.env` | Owner login for `db:migrate`, `db:seed`, `db:reset` only |
| `ANTHROPIC_API_KEY` | `.env.local` | Uploaded invoices are read by Claude; without it they open for manual entry. In-memory demo and Docker: the inbox bills are already read |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` | `.env.local` | Live Gmail intake. Get the refresh token once on the host: `npm run gmail:auth`. Without them the poller prints why and stops; the rest still runs |
| `EXTRACTION_MODEL`, `INTAKE_CLASSIFIER_MODEL` | `.env.local` | Override the Claude model (default `claude-opus-5-5`) |
| `DEMO_SCENARIO=3` | environment | Quick demo starts with 3 clean bills already sent to approval |
| `UPLOAD_DIR` | environment | Where uploaded files are kept (default `.data/uploads`) |

## Demo

One person per role. Only these seven can sign in:

| Person | Role | In the demo |
| --- | --- | --- |
| Aiden Grant | Employee | Read-only: Home + **My bills** (the bills they requested) |
| Jordan Okafor | AP Clerk | Inbox, Checks, upload, coding, submit; schedules payments |
| Dev Malhotra | Operations Manager | Approves the Operations bills policy routes to the department manager |
| Elise Tremblay | Finance Manager | Releases payments ≤ $100k CAD; verifies bank changes |
| Marcus Webb | Admin (Controller) | People & policies, releases what the Finance Manager can't, full audit log, **Reset demo data** |
| Priya Raman | CFO | Approves over $250k CAD and bills escalated to her; releases payments the Controller approved (any amount) |
| Hannah Lindqvist | Auditor | Read-only everything, audit trail + export |

- **Switch person:** the **Viewing as** menu, top right (it takes you to that person's Home).
- **Demo controls** (link in the top bar, or `/demo`): **Send bank answer** for a released payment
  (Settled, or a failure such as closed account), **Send 3 clean bills to approval**, and
  **Reset demo data** (Admin; in-memory demo and Docker).
- **One-click sign-in** (in-memory demo only; 404 on any other database): `/demo/as/U004?next=/checks`.
- Click-by-click, ~2 minutes, including a Claude-read upload: [`docs/demo-script.md`](docs/demo-script.md).
  Screens per role: [`docs/architecture/dashboard.md`](docs/architecture/dashboard.md).

## Features

| # | Feature | What it does | Owner | Main page(s) |
| --- | --- | --- | --- | --- |
| 1 | Intake | Gmail and the dataset inbox become draft bills; non-invoice emails are classified and kept out, with the reason; PDF upload | Arpan | Inbox `/inbox`, Upload invoices `/checks/upload` |
| 2 | Extraction | Claude reads each document: type, vendor, number, dates, lines, currency, each tax mapped to a tax code; unreadable → manual entry, low-confidence fields say **Check this** | Arpan | Upload invoices `/checks/upload`, Checks `/checks/[id]` |
| 3 | Smart coding | GL account + department per line, learned from history, with confidence and reason; a person accepts or changes it | Youssef | Checks `/checks/[id]` |
| 4 | Validation | Vendor, contract, PO, tax by province of delivery, arithmetic; every discrepancy is a flag with its numbers | Andrew | Checks `/checks` |
| 5 | Duplicates | Same file, reformatted numbers, same amount within 7 days, already paid by employee card; a person decides each | Arpan | Duplicates `/payments/duplicates` |
| 6 | Approvals | Routes by amount (CAD), department, vendor status and policy; delegates and leave; Admin edits policies | Youssef | Approvals `/approvals`, People & policies `/admin` |
| 7 | Payments | Schedule and release simulated EFT with release rules and separation of duties; failures, retries, bank change + second-person verify | Katie | Payments `/payments` (Overview, To schedule, To release, Needs attention) |
| 8 | Audit trail | Every action: who, when, on whose behalf, before and after; control checks, export | Andrew | Audit trail `/audit`, Invoices `/invoices` |
| 9 | Vendors | Vendor master, onboard + second-person approval, hold, bank-detail change requested by one person and verified by another | Andrew (server), Youssef (screen) | Vendors `/vendors` |

Also: the dashboard for all roles (Youssef) and the bonus **Journal export** `/journal` (Youssef).

## How it works

```
email (Gmail / dataset inbox) or upload
  1 intake        stored document (sha256) → draft bill        Received
  2 extraction    fields read, or manual entry                 → InReview  (or ManualEntry)
  3 coding · 4 validation · 5 duplicates
                  suggestions + flags, re-run on every edit
  6 approvals     route from policy                            → PendingApproval → Approved
  7 payments      simulated EFT                                → PaymentScheduled → Paid
  8 audit         every step writes an audit event in the same transaction
```

- **Stack:** Next.js (App Router) + TypeScript + Tailwind CSS. The backend is `src/server/`, called
  from server actions and route handlers; the browser never talks to the database.
- **Database:** PostgreSQL via Drizzle (Docker locally; PGlite in-process for tests and the
  no-Docker demos). Deploy: Vercel + Supabase recommended, still an open decision ([`docs/STATUS.md`](docs/STATUS.md)).
- **Stages hand off** through Zod schemas in `src/contracts/`, and the database at runtime.

Design rules, in plain words:

- **Every status change goes through `fire()`** ([`src/server/core/fire.ts`](src/server/core/fire.ts)):
  it checks the move is legal, checks its guard and writes the audit event in the same transaction.
  The audit table is append-only; the app's `ap_app` login cannot edit or backdate it.
- **Every action is checked on the server with `authorize()`** ([`src/server/core/authorize.ts`](src/server/core/authorize.ts)).
  Hiding a button is cosmetic; calling the action as the wrong role is refused (403).
- **Separation of duties, on the server:** nobody approves their own request; the requester,
  approver or scheduler of a payment can't release it; vendor and bank changes need a second person.
- **Money is integer cents**, rates are decimals, never JavaScript floats ([`docs/rules/money-and-tax.md`](docs/rules/money-and-tax.md)).
- **LLMs only for fuzzy reading:** Claude classifies emails and reads documents. Coding suggestions
  come from history (no LLM today). Validation, duplicate verdicts, approval routing and
  permissions are deterministic code. No key, or a document it can't read → manual entry, never a silent guess.

## Checks

Use Node.js 22 or 24. Run `npm ci` first.

| Command | What it does |
| --- | --- |
| `npm run check` | TypeScript, loads every production module, all tests, batch + history replays |
| `npm test` | All unit, contract and fixture tests (Vitest) |
| `npm run test:contracts` | Just the shared schema checks |
| `npm run validate:batch` | Validation over the incoming batch; expectation mismatches exit with a failure status |
| `npm run validate:history` | Replays the 426 historical invoices and counts flags per code (the false-positive check) |
| `npm run duplicates:batch` | Duplicate check over the incoming batch and the history; prints every flag |
| `npm run lint` | ESLint |
| `npm run build` | Production build |

The history CLI prints diagnostics, while the history tests enforce expectations.

**CI** (`.github/workflows/ci.yml`) runs on every pull request and push to `main`, on Linux with
Node 22 and 24: `npm ci`, `typecheck`, `check:imports`, `test:contracts`, `test`,
`validate:batch`, `validate:history`. It does not run `lint` or `build`. Configure
`Node 22 checks` and `Node 24 checks` as required checks in GitHub branch protection to prevent
merging a failing PR. A Claude review workflow also comments on every non-draft PR; it never
approves or blocks.

## Repo layout

```
app/                 Next.js pages, one area per screen (inbox, checks, approvals, payments,
                     vendors, invoices, audit, journal, admin, demo)
src/
├── contracts/       Zod schemas: the hand-off between stages
└── server/
    ├── core/        fire(), authorize(), audit emitter
    ├── db/          Drizzle schema, migrations, seed
    ├── features/    one folder per feature (intake, extraction, coding, validation, duplicates,
    │                approvals, payments, audit, vendors) + invoices, journal
    ├── pipeline/    the stages on Postgres, each step audited
    ├── dashboard/   read-side queries, one per screen
    ├── session/     sign-in, roles, the six-person demo cast
    └── demo/        in-memory demo database, reset, scenario
fixtures/            frozen outputs of each stage, so downstream work never waits on upstream
brim_ap_dataset/     the dataset as delivered (data/*.csv, inbox/, incoming_invoices/); never
                     edit it. Schema in its README.md
scripts/             migrate, seed, reset, demo, Docker setup, Gmail, validation + duplicate replays
docker/init/         creates the app's `ap_app` database login
docs/                see below
```

## Docs map

| Doc | What's in it |
| --- | --- |
| [`docs/STATUS.md`](docs/STATUS.md) | Where the project is right now: owners, progress, open decisions |
| [`docs/product.md`](docs/product.md) | The 9 required features, the six roles, what's in scope |
| [`docs/brief.md`](docs/brief.md) | Official hackathon brief |
| [`docs/demo-script.md`](docs/demo-script.md) | 2-minute click-by-click demo, plus the upload demo |
| [`docs/demo-workflow.md`](docs/demo-workflow.md) | Live-Gmail demo run sheet |
| [`docs/running-with-docker.md`](docs/running-with-docker.md) | Docker step by step + troubleshooting |
| [`docs/architecture/`](docs/architecture/README.md) | Index of architecture docs: [`overview.md`](docs/architecture/overview.md), one doc per feature, [`dashboard.md`](docs/architecture/dashboard.md), [`roles-and-permissions.md`](docs/architecture/roles-and-permissions.md) |
| [`docs/explainers/`](docs/explainers/) | Domain primer, state machine and dependency diagrams |
| [`docs/rules/`](docs/rules/) | Coding rules (backend, contracts, db, frontend, money and tax); read the one for the files you touch |
| [`docs/todo/TODO.md`](docs/todo/TODO.md) | Open work by feature ([done](docs/todo/tasks-completed.md)) |
| [`docs/bugs/bugs.md`](docs/bugs/bugs.md) | Open bugs ([fixed](docs/bugs/fixed-bugs.md)) |
| [`.claude/CLAUDE.md`](.claude/CLAUDE.md) | Team contract: stack, layout, hard rules |
