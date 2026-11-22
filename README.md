# Hackathon-winner-POV

Accounts payable (AP) automation for the Brim hackathon. A web app that takes supplier invoices for the fictional company Harborline Logistics from inbox to payment: read → code → validate → approve → pay → audit trail.

## Stack

- Next.js (App Router) + TypeScript + Tailwind CSS
- PostgreSQL (Docker locally; Vercel + Supabase recommended for deploy, see `docs/STATUS.md`)
- Hosted on Vercel

## Running locally

Requires Node 22+. No Docker needed for the demo.

```bash
npm install
npm run dev
```

Then open http://localhost:3000 and pick who you are (AP Clerk, Operations Manager, Finance
Manager, Admin, Auditor). With no `DATABASE_URL`, the app builds an in-process Postgres from the
dataset on the first request (~5 s): 10 months of history plus the AP inbox run through intake.
A restart, or **Demo controls → Reset** (Admin), starts again from the dataset.

| Setting | Effect |
| --- | --- |
| `DATABASE_URL` | Use a real Postgres instead (`npm run db:up && npm run db:reset`, see `.env.example`) |
| `ANTHROPIC_API_KEY` | Uploaded invoices are read by Claude; without it they open for manual entry |
| `DEMO_SCENARIO=3` | Start with 3 clean bills already sent to approval (same as the Demo controls button) |
| `UPLOAD_DIR` | Where uploaded files are kept (default `.data/uploads`) |

One-click sign-in for a demo: `/demo/as/U004?next=/checks` (demo database only). The app's
screens and roles are described in `docs/architecture/dashboard.md`.

## Repo layout

| Path | What's in it |
| --- | --- |
| `app/` | Next.js routes, one area per role |
| `src/` | Backend services and shared contracts (see `.claude/CLAUDE.md` for the target layout) |
| `brim_ap_dataset/` | The Harborline dataset as delivered; never edit it. Schema in its `README.md` |
| `docs/STATUS.md` | Where the project is right now: owners, open decisions |
| `docs/product.md` | The 9 required features and what's in scope |
| `docs/brief.md` | Official hackathon brief |
| `docs/` (rest) | Architecture, coding rules, explainers, TODO and bugs |

## Status

The app runs end to end: inbox → checks → approvals → payments → audit trail, per role. Duplicates
(feature 5) has no screen yet. See `docs/STATUS.md` for current progress.

## Checks

Use Node.js 22 or 24. Run `npm ci`, then `npm run check` to check TypeScript,
load every production TypeScript module, run unit and contract tests, and replay
the incoming batch and historical invoices. `npm run test:contracts` runs just the
shared schema checks. Batch expectation mismatches exit with a failure status;
the history CLI prints diagnostics, while the history tests enforce expectations.

The `CI` workflow runs these checks on every pull request and push to `main`, on
Linux with both Node versions. Configure `Node 22 checks` and `Node 24 checks` as
required checks in GitHub branch protection to prevent merging a failing PR.
