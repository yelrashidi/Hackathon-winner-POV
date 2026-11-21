# Payments dashboard — to-do

Pages under `/payments`, with a sidebar and a "Viewing as" switcher. Owner: Katie (dashboard session, branch `dashboard`). Decisions: `docs/payment-decisions.md` → Dashboard decisions (see "Waiting to be recorded" below).
Target: working demo by ~7pm 2026-11-21, merged with `Katie` and tested by 9–10pm.

Everything the dashboard needs from other features sits behind one adapter and is marked `// TEMP:` until the real code exists.

Payment statuses (data model): `scheduled`, `released`, `settled`, `failed`, `cancelled`, plus `on_hold` (TEMP name: the payment session keeps holds on the payment; confirm in `docs/payment-data.md`). "Approved" is an invoice status and only appears in "Awaiting payment".

## Done

- [x] Sample data (one labelled file) + `getPayments()` server adapter.
- [x] Money/date formatters (`// TEMP:`) + status badges.
- [x] Table, summary cards, "Needs attention" and "Awaiting payment" sections, attempt history — currently all on one page; step B splits them into pages.

## Working demo (in order)

- [x] A. "Viewing as" switcher: read `users.csv` on the server, `getCurrentUser()` from a cookie (`// TEMP:`), menu in the top-right grouped Clerk / Finance Manager / Controller / Other employee (view only). Switches people, not roles; the role is always looked up on the server. (45 min)
- [x] B. Layout + sidebar: split into Overview `/payments`, To schedule `/payments/to-schedule`, Needs attention `/payments/needs-attention`. Sidebar shows only the role's pages; each page checks the same list on the server. View-only users get no Actions spots. (45 min)
- [x] C. Sample data: `on_hold` status + a held payment (same vendor as a closed account), requester on each invoice, one payment scheduled by the Finance Manager. (20 min)
- [x] D. Release queue `/payments/to-release`: per row, can the signed-in person release it? (Can release / Needs Controller over $100k CAD / You approved it / You scheduled it / You requested it). Controller also sees escalations (FRAUD_HOLD, ACCOUNT_FROZEN). `// TEMP:` copy of the release rules until the payment session's check exists. (45 min)
- [x] E. Details `/payments/[invoiceId]`: invoice + payment summary, attempt history, audit trail (sample, built from the records), why the signed-in person can or can't release. (45 min)
- [x] F. Overview filters by status and vendor (URL params, filtered on the server). (30 min)
- [x] G. Commit on `dashboard`, run `npm run dev`, click through every role. (15 min)

**Checkpoint (~7pm):** demo works end to end on sample data.

## After the checkpoint

- [ ] H. UI polish — UI is 20% of the score: spacing, hierarchy, empty states, narrow screens. (~2 h)
- [ ] I. Connect, as soon as `docs/payment-data.md` is ready (interrupts polish): `git merge Katie`, switch `getPayments()` to the real format, swap the TEMP release rules for the payment session's, put its Schedule/Release/Retry buttons in the Actions spots. (45 min)
- [ ] J. Run the demo flow (release → fail → fix bank → retry → settled) on the merged app; fix what breaks. (30 min)

Dropped: role filter (the switcher replaces it).

## Waiting to be recorded in docs/payment-decisions.md

That file doesn't exist yet (not committed on `Katie`). Once the payment session commits it and Katie OKs `git merge Katie`, move these into its Dashboard decisions section and Decision log, then delete this section.

- Dashboard decision 1 (was "one view, role filter nice-to-have") → No login page. "Viewing as: name (role)" switcher top-right on every page; picks a person from the dataset (cookie), grouped Clerk / Finance Manager / Controller / Other employee (view only). *Why:* separation of duties depends on who approved or scheduled, so the demo must switch people, not roles. Role still comes from the employee record on the server via `getCurrentUser()` (TEMP).
- New: the dashboard is split into pages with a sidebar: Overview, To schedule (Clerk), Release queue (Finance Manager ≤ $100k CAD, larger = "Needs Controller"; Controller sees all plus escalations), Needs attention (failed + on hold), Details per payment (attempt history, audit trail, blocked reasons). *Why:* each role gets its own screen (UI is 20% of the score) and switching people visibly changes the app.
- New: the sidebar shows only the current role's pages; "Other employee" is read-only with no actions. *Why:* each role sees only what it can act on; pages also check on the server, since hiding a link isn't security.
- Unchanged: action buttons come from the payment session; the dashboard keeps TEMP "Actions" spots.
- Login and roles section → replace "Sign in as… page" with the switcher above.
- Decision log line: `Nov 21 | Sign-in and page layout | Switcher instead of login page; split into role-specific pages with a sidebar | Katie`
