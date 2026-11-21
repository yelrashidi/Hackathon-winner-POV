# Hackathon-winner-POV

Accounts payable (AP) automation for the Brim hackathon. A web app that takes supplier invoices for the fictional company Harborline Logistics from inbox to payment: read → code → validate → approve → pay → audit trail.

## Stack

- Next.js (App Router) + TypeScript + Tailwind CSS
- SQL database (Postgres, details TBD)
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
| `src/app/` | Next.js pages and API routes |
| `docs/brief.md` | Official hackathon brief |
| `docs/challenge-explained.md` | Plain-language explainer of the challenge and how it's scored |
| `data/data/` | Synthetic AP history, Jan–Oct 2026 (vendors, invoices, POs, contracts, approvals, payments, bank statement, …) |
| `data/incoming_invoices/` | 56 unprocessed invoices (PDF/PNG) to run through the app |
| `data/inbox/emails.json` | 59 unprocessed emails to the AP inbox |
| `data/README.md` | Dataset schema and notes |

## Status

Early setup: the Next.js app is scaffolded (default starter page). Architecture and features will be documented here as we build.
