# Dashboard — one app, five roles

**Owner:** Youssef · **Code as of:** `dashboard-redesign` (on `cfde335`)

## What it does
One Next.js app with a screen per job, on top of the real pipeline in Postgres. A bill goes
**Inbox → Checks → Approvals → Payments → Audit trail**, and each person sees only their part.
The role always comes from the user's employee record on the server; every button calls a pipeline
service that runs `authorize()` → one transaction → audit rows → `fire()`.

## Roles and what each sees (team plan, 2026-11-21)

Access widens with seniority. Approval *routing* follows `approval_policies.csv` (the brief's rules);
the brief also decides payments: AP clerks prepare, the Finance Manager releases ≤ $100k, the
Controller (our Admin) releases > $100k and whatever the Finance Manager approved (P09–P11).

| Screen | AP Clerk | Ops Manager¹ | Finance Mgr | Admin | Auditor |
|---|---|---|---|---|---|
| Home (what's waiting on me) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Inbox, Checks, Upload | ✓ | ✓ | ✓ | ✓ | — |
| Approvals (routed to me by policy) | — | ✓ ≤ $10k, own dept | ✓ | ✓ > $50k | — |
| Payments: overview, needs attention | ✓ | — | ✓ | — | — |
| Payments: to schedule | ✓ | — | — | — | — |
| Payments: to release | — | — | ✓ | only what the FM can't² | — |
| Vendors (bank change: enter / verify) | enter | — | verify | verify | — |
| Audit trail | ✓ | ✓ | ✓ | ✓ + export | past invoices only + export |
| People & policies | — | — | — | ✓ | — |

¹ Approval routing still sends each department's bills to its own manager (policy file); the demo
cast is **one person per role** (`src/server/session/roster.ts`: Jordan Okafor, Dev Malhotra
(Operations), Elise Tremblay, Marcus Webb, Hannah Lindqvist). Only they can sign in, and they are
the only requesters the forms offer, so a 2–3 minute demo stays simple. Demo walkthrough:
[`../demo-script.md`](../demo-script.md).
² `pipeline/payments.ts` `adminReleaseGuard`: refused with the Finance Manager's name when she may release it.

Enforced in three places that agree: `app/_lib/nav.ts` (what the sidebar shows and each page checks),
`src/server/core/authorize.ts` (the matrix every service runs), and the services' data rules
(`checkDecision`, payments' `checkRelease`). See `roles-and-permissions.md`.

## How it's built

- **Database.** `DATABASE_URL` set → Postgres. Unset → `src/server/demo/database.ts` builds an
  in-process Postgres (PGlite, as in the tests) on first request: migrations → seed (10 months of
  history and its audit trail) → the 59 inbox emails through the real intake path
  (`demo/load-inbox.ts`, with frozen extraction readings so it runs offline). ~5 s; no Docker.
- **Read side** `src/server/dashboard/*`: one query module per screen (checks, approvals, audit,
  records = inbox/vendors/activity), each checks `authorize` like the writes do.
- **Write side** `app/**/actions.ts` → `src/server/pipeline/*`. The actor is always the session's.
- **Payments on Postgres** `src/server/pipeline/payments.ts`: Katie's service + rules unchanged; each
  call loads its state from the tables (AsyncLocalStorage-scoped), runs the action, then writes the
  diff (payments, payment_flags, bank accounts) and replays its invoice events through `fire()` and
  its audit events into `audit_events` — one transaction. Only a fully approved plan approves a
  payee and amount (TODO review finding).
- **New pipeline pieces:** `previewApproval` (the route submit *would* make — same input builder as
  `submitForApproval`), `releaseHold`, `enterInvoiceFields` (manual entry), documents store +
  `/documents/[id]`, Admin `updatePolicy` (new version row) / `setUserAvailability` (on leave +
  delegate) / `createVendor` / `setVendorStatus`.

## Flags it raises
None of its own: it shows validation's, coding's and payments' flags. Closing one needs a note
(`overrideFlag` / `resolveFlag`); coding's flags clear when the lines are confirmed.

## Bad input
- **Unreadable bill** (no model, scan) → `ManualEntry` → the clerk types it beside the document.
- **Upload without `ANTHROPIC_API_KEY`** → the form opens empty (manual entry); with the key, Claude reads it.
- **Missing requester** → Checks says so; approvals can't route until it is set.
- **Typing a URL as the wrong role** → "not for your role"; calling the action → the service's 403 reason.

## At 100× volume
The Checks and Approvals queues load every open invoice per request (fine at ~50/month); at 100×,
paginate and push the reason calculation into SQL. Payments loads only open work per request.
PGlite is single-connection: production runs on Postgres (`DATABASE_URL`).

## Known gaps
Duplicates (feature 5) has no screen (no owner). Demo sign-in is a cookie, not real auth.
Uploads are stored on local disk (`UPLOAD_DIR`); deployed, use object storage. Payments loads EFT
only (cheque/card in `payment-todo.md`).
