# Roles and permissions

**Code as of:** `dashboard-redesign`. Foundation doc; `src/server/core/authorize.ts` implements it.

> **Dashboard plan (2026-11-21):** access widens with seniority — managers and the Finance Manager can
> do the clerk's checks. **Invoices** (read-only records with who did what) follow the "View invoices"
> row below (`src/server/features/invoices/`). **The full audit log** (every event with before/after,
> control checks, export) is for the Auditor ("read-only everything, audit export") and the
> Controller/Admin ("full audit log"), per `product.md`; others see their own recent actions on the home screen.
> Doing the checks never lets you approve your own work: the submitter is excluded from the approval.
> The Admin's release limits are enforced in `src/server/pipeline/payments.ts` (`adminReleaseGuard`).
> **Employee (2026-11-22): read-only.** Their screens are Home and **My bills** (`/invoices`, scoped to
> the bills they requested, each with where it is in plain words). Bills reach AP from suppliers and the
> AP Clerk records the employee as the requester on Checks, so employees submit nothing: `invoice.submit`
> refuses them on the server (`src/server/core/authorize.ts`, decided by Andrew 2026-11-22).
> Screens per role: [`dashboard.md`](dashboard.md).

## One function decides

```ts
authorize(actor: Actor, action: Action, resource?: Resource): void  // throws Forbidden with a reason
```

Every mutating route handler and server action calls it **before** touching data. The UI calls
the same `can()` variant only to decide what to show. Hidden buttons are cosmetic; this is the
control. A refusal is a 403 with a reason the UI shows (`You approved this invoice, so you cannot release its payment`).

## The matrix

| Action | Employee | AP Clerk | Approver | Finance Mgr | Controller | Auditor |
|---|---|---|---|---|---|---|
| Send a checked bill to approval (`invoice.submit`) | — (read-only) | ✓ | ✓ | ✓ | ✓ | — |
| View invoices (`/invoices`, read-only, with who did what) | own: the bills they requested ("My bills") | all | own dept | all | all | all |
| Ingest inbox, review extraction, code, resolve flags ("checks") | — | ✓ | ✓ | ✓ | ✓ | — |
| Approve / reject a step | — | — | own dept, ≤ limit | above dept limits, flagged, new vendor | ✓ | — |
| Prepare (schedule) payment | — | ✓ (the normal path, P09) | — | ✓ backup¹ | — (dashboard: the Admin does not prepare) | — |
| Release payment | — | — | — | ≤ $100,000 CAD | only what the Finance Manager can't (> $100k, or she approved it) | — |
| View the vendor master | — | ✓ | — | ✓ | ✓ | ✓ (read-only) |
| Onboard a vendor, put a vendor on hold | — | ✓ | — | ✓ | ✓ | — |
| Request vendor bank change | — | ✓ | — | ✓ | ✓ | — |
| Verify vendor bank change / approve new vendor / lift a hold | — | — | — | ✓ (not their own entry) | ✓ (not their own entry) | — |
| Edit users, roles, approval policies | — | — | — | — | ✓ | — |
| View the full audit log (`/audit`) | — | — | — | — | ✓ | ✓ (every invoice) |
| Export the audit log | — | — | — | — | ✓ | ✓ |
| Export the accounting journal (bonus) | — | — | — | ✓ | ✓ | — |

¹ **Who schedules (decided 2026-11-21):** the AP Clerk schedules and the Finance Manager releases (P09;
every historical payment was prepared by a clerk). The Finance Manager may schedule as a backup when
no clerk is available, but whoever schedules a payment can never release it (payments' `SCHEDULED_IT`
check + a DB CHECK), so a payment the Finance Manager schedules is released by the Controller.

## The rules that apply to everyone — the ones judges will test

1. **Nobody approves an invoice they requested.** The step escalates to the requester's manager
   (`users.manager_id`). If that manager is the requester too, it goes up again.
2. **Whoever approved any step of an invoice cannot release its payment** — Controller included.
   Checked against `approval_steps.acted_by` *and* `on_behalf_of` for the current invoice version.
3. **A verified bank change needs two people:** the requester of the change cannot verify it.
4. **A delegate acts as themselves, on behalf of the absent approver.** `acted_by` = delegate,
   `on_behalf_of` = approver; their own limit and conflict rules still apply (a delegate who
   requested the invoice still cannot approve it).
5. **Limits are compared in CAD** — `total_cad_cents`, converted at the invoice-date rate.
6. **Auditor writes nothing.** Every write action denies the Auditor role by default.

## The dataset's policies (`approval_policies.csv`) — load them, do not hardcode them

- **Amount chain (CAD):** ≤ $10k dept manager · > $10k + finance manager · > $50k + controller ·
  > $250k + CFO (the CFO is a `controller_admin` user). Steps are sequential.
- **Extra finance-manager step** for new / `pending_review` vendors (P05) and Legal-category vendors (P06).
- **Self-approval escalates to the approver's manager** (P07); **on leave routes to `delegate_user_id`** (P08).
- **Release:** ≤ $100k finance manager, > $100k controller (P09, P10), never the invoice's approver (P11).
- **Matching:** over the PO's remaining balance → finance manager (P12); a vendor that requires a PO and has none → hold (P13).

**There is exactly one finance manager in the data.** Any invoice over $10k has them as an
approver, so P11 forbids them from releasing it — a controller must. The release screen has to
say why, and the routing has to find the controller, not dead-end.

## Test this as a matrix, not by hand

One table-driven test: `(role, action, situation) → allowed | reason`. It doubles as the answer
to *how are roles enforced?* in the Q&A, and it catches a regression the moment someone loosens a check.
