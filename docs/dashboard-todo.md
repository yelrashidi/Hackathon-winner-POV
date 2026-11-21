# Payments dashboard — to-do

Pages under `/payments`, with a sidebar and a "Viewing as" switcher. Owner: Katie (dashboard session, branch `dashboard`). Decisions: `docs/payment-decisions.md` → Dashboard decisions and the Dashboard log.
Target: working demo by ~7pm 2026-11-21, merged with `Katie` and tested by 9–10pm.

The dashboard reads and acts through the real payments code (`src/server/features/payments`, contract `src/contracts/payment.ts`). It has no copies of payment types, sample data, failure reasons or rules any more. **What is still TEMP, and who each piece waits on:** [`payment-assumptions.md`](payment-assumptions.md) → "Still TEMP" (`grep -rn "TEMP:" src/ app/` finds each one in code).

Payment statuses: `scheduled`, `released`, `settled`, `failed`, `cancelled`, `on_hold`, as in [`payment-data.md`](payment-data.md). "Approved" is an invoice status and only appears in "Awaiting payment".

## Done

- [x] `getPayments()` server adapter (sample data at first; real payments data since step I).
- [x] Money/date formatters (still `// TEMP:` until `core/money.ts`) + status badges.
- [x] Table, summary cards, "Needs attention" and "Awaiting payment" sections, attempt history — currently all on one page; step B splits them into pages.

## Working demo (in order)

- [x] A. "Viewing as" switcher: read `users.csv` on the server, `getCurrentUser()` from a cookie (`// TEMP:`), menu in the top-right grouped Clerk / Finance Manager / Controller / Other employee (view only). Switches people, not roles; the role is always looked up on the server. (45 min)
- [x] B. Layout + sidebar: split into Overview `/payments`, To schedule `/payments/to-schedule`, Needs attention `/payments/needs-attention`. Sidebar shows only the role's pages; each page checks the same list on the server. View-only users get no Actions spots. (45 min)
- [x] C. Sample data (deleted in step I): `on_hold` status + a held payment (same vendor as a closed account), requester on each invoice, one payment scheduled by the Finance Manager. (20 min)
- [x] D. Release queue `/payments/to-release`: per row, can the signed-in person release it? (Can release / Needs Controller over $100k CAD / You approved it / You scheduled it / You requested it). Controller also sees escalations (FRAUD_HOLD, ACCOUNT_FROZEN). Now shows the server's own release check and list of who can release (the TEMP copy is gone). (45 min)
- [x] E. Details `/payments/[invoiceId]`: invoice + payment summary, attempt history, audit trail (now the real payments audit log), why the signed-in person can or can't release. (45 min)
- [x] F. Overview filters by status and vendor (URL params, filtered on the server). (30 min)
- [x] G. Commit on `dashboard`, run `npm run dev`, click through every role. (15 min)

**Checkpoint (~7pm):** demo works end to end on sample data.

## After the checkpoint

- [x] H1. Brim-inspired theme: blue frame, turquoise accent, display font; colours in `app/payments/brim-theme.css`. (45 min)
- [x] H2. Urgency flags (critical/high/low): badges, open-flag counts, Needs attention sorted most urgent first, flags card on details, Clear flag button for the people the server's clear rule allows. (45 min)
- [x] H3. Upload screen `/payments/upload` (AP Clerk + Controller): drop zone, one-by-one reading, original beside the form, Confirm → In review (TEMP memory store). Extraction stays behind `extraction-adapter.ts`, which answers "unavailable" until extraction exists, so every file is manual entry. (2 h)
- [ ] H. UI polish — UI is 20% of the score: spacing, hierarchy, empty states, narrow screens. (~2 h)
- [x] I. Connected (2026-11-21, on `Katie`): `getPayments()` reads the real payments data; the copied types, sample data, failure reasons and release rules are deleted; the real Schedule / Release / Retry / Schedule again / Clear flag / Cancel / bank change buttons sit on the dashboard; `/payments-console` keeps only the simulated bank and "Reset demo data".
- [x] J. Demo flow (release → fail → fix bank → retry → settled, fraud hold, bank change reject, cancel, view-only roles) clicked through by Katie on the merged app, 2026-11-21.

Dropped: role filter (the switcher replaces it).
