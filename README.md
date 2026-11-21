# Hackathon-winner-POV

Accounts payable (AP) automation for the Brim hackathon. A web app that takes supplier invoices for the fictional company Harborline Logistics from inbox to payment: read → code → validate → approve → pay → audit trail.

## Stack

- Next.js (App Router) + TypeScript + Tailwind CSS
- PostgreSQL (Docker locally; Vercel + Supabase recommended for deploy, see `docs/STATUS.md`)
- Hosted on Vercel

## Running locally

Requires Node 20+.

```bash
npm install
npm run dev
```

Then open http://localhost:3000.

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

Early setup: the Next.js app is scaffolded (default starter page). See `docs/STATUS.md` for current progress.

## Checks

Use Node.js 22 or 24. Run `npm ci`, then `npm run check` to check TypeScript,
load every production TypeScript module, run unit and contract tests, and replay
the incoming batch and historical invoices. `npm run test:contracts` runs just the
shared schema checks. Batch expectation mismatches exit with a failure status;
the history CLI prints diagnostics, while the history tests enforce expectations.

The `CI` workflow runs these checks on every pull request and push to `main`, on
Linux with both Node versions. Configure `Node 22 checks` and `Node 24 checks` as
required checks in GitHub branch protection to prevent merging a failing PR.
