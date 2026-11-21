# Hackathon-winner-POV

Accounts payable (AP) automation for the Brim hackathon. A web app that takes supplier invoices for the fictional company Harborline Logistics from inbox to payment: read → code → validate → approve → pay → audit trail.

## Repo layout

| Path | What's in it |
| --- | --- |
| `docs/brief.md` | Official hackathon brief |
| `docs/challenge-explained.md` | Plain-language explainer of the challenge and how it's scored |
| `data/data/` | Synthetic AP history, Jan–Oct 2026 (vendors, invoices, POs, contracts, approvals, payments, bank statement, …) |
| `data/incoming_invoices/` | 56 unprocessed invoices (PDF/PNG) to run through the app |
| `data/inbox/emails.json` | 59 unprocessed emails to the AP inbox |
| `data/README.md` | Dataset schema and notes |

## Status

Early setup. Stack, architecture and how to run the app will be added here as we build.

## Checks

Use Node.js 22 or 24. Run `npm ci`, then `npm run check` to check TypeScript,
load every production TypeScript module, run unit and contract tests, and replay
the incoming batch and historical invoices. `npm run test:contracts` runs just the
shared schema checks. Batch expectation mismatches exit with a failure status;
the history CLI prints diagnostics, while the history tests enforce expectations.

The `CI` workflow runs these checks on every pull request and push to `main`, on
Linux with both Node versions. Configure `Node 22 checks` and `Node 24 checks` as
required checks in GitHub branch protection to prevent merging a failing PR.
