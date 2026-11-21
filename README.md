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
