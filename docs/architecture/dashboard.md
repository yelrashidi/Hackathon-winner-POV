# Dashboard — one app, six roles

**Owner:** Youssef · **Code as of:** `dashboard-redesign` (merged with main `e4ecc52`)

## What it does
One Next.js app with a screen per job, on top of the real pipeline in Postgres. A bill goes
**Inbox → Checks → Approvals → Payments → Audit trail**, and each person sees only their part.
The role always comes from the user's employee record on the server; every button calls a pipeline
service that runs `authorize()` → one transaction → audit rows → `fire()`.

## Roles and what each sees (team plan, 2026-11-21)

Access widens with seniority. Approval *routing* follows `approval_policies.csv` (the brief's rules);
the brief also decides payments: AP clerks prepare, the Finance Manager releases ≤ $100k, the
Controller (our Admin) releases any amount, and only they release > $100k (P09–P11).

| Screen | Employee³ | AP Clerk | Ops Manager¹ | Finance Mgr | Admin | Auditor |
|---|---|---|---|---|---|---|
| Home (what's waiting on me) | "My bills" summary | ✓ | ✓ | ✓ | ✓ | ✓ |
| Inbox, Checks, Upload | — | ✓ | ✓ | ✓ | ✓ | — |
| Approvals (routed to me by policy) | — | — | ✓ ≤ $10k, own dept | ✓ | ✓ > $50k | — |
| Payments: overview, needs attention, payment details | — | ✓ | details only | ✓ | details, releases | details |
| Payments: to schedule | — | ✓ | — | — | — | — |
| Payments: to release | — | — | — | ✓ | ✓ any amount² | — |
| Vendors (bank change: enter / verify) | — | enter | — | verify | verify | read-only |
| Invoices (read-only records + who did what) | **My bills**: the ones they requested | all | own department | all | all | all |
| Audit trail (full audit log) | — | — | — | — | ✓ + export | every invoice + export |
| People & policies | — | — | — | — | ✓ | — |

¹ Approval routing still sends each department's bills to its own manager (policy file); the demo
cast is **one person per role, six people** (`src/server/session/roster.ts`, picked by rule: Aiden
Grant, Jordan Okafor, Dev Malhotra (Operations), Elise Tremblay, Marcus Webb, Hannah Lindqvist). Only
they can sign in. The **requester** on Checks is anyone who can order (active employees, AP clerks and
managers of every department, grouped by department, the bill's own first —
`dashboard/checks.ts` `reviewOptions`), because the clerk records who asked for the bill; it is
rarely the clerk. Demo walkthrough: [`../demo-script.md`](../demo-script.md).
² The Controller (Admin) releases any amount, the Finance Manager up to $100,000 CAD; neither releases what they approved (P11, `features/payments/rules.ts` `checkRelease`). Changed 2026-11-22: the Admin was limited to what the FM couldn't release.
³ **Employee (2026-11-22):** read-only — Home + My bills, every other URL "not for your role", every
action refused on the server (`invoice.submit` included). The cast's employee is the first active
employee reporting to the cast's manager, so the bills the clerk records them on route to Dev. Each
bill shows where it is in plain words (`features/invoices` `plainStatus`: in checks · waiting for
<approver> · approved · scheduled · paid · rejected). Test: `src/server/dashboard/__tests__/employee.test.ts`.

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
- **Payments** are Katie's service on Postgres (PR #15); `src/server/pipeline/payments.ts` is a thin
  wrapper that adds the brief's Admin release rule. **Vendors** buttons call Andrew's
  `features/vendors` (feature 9); **Duplicates** is Arpan's screen (`/payments/duplicates`) in the
  shared sidebar. Only a fully approved plan approves a payee and amount (`payments/deps.ts`).
- **New pipeline pieces:** `previewApproval` (the route submit *would* make — same input builder as
  `submitForApproval`), `releaseHold`, `enterInvoiceFields` (manual entry), documents store +
  `/documents/[id]`, Admin `updatePolicy` (new version row) / `setUserAvailability` (on leave +
  delegate).

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
Demo sign-in is a cookie, not real auth.
Uploads are stored on local disk (`UPLOAD_DIR`); deployed, use object storage. Payments loads EFT
only (cheque/card in `payment-todo.md`).
