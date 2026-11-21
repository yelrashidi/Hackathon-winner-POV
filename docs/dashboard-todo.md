# Payments dashboard — to-do

Page: `/payments`. Owner: Katie (dashboard session, branch `dashboard`). Decisions: `docs/payment-decisions.md` → Dashboard decisions.
Target: working demo by ~7pm 2026-11-21, merged with `Katie` and tested by 9–10pm.

Everything the dashboard needs from other features sits behind one adapter in `app/payments/_lib/` and is marked `// TEMP:` until the real code exists.

Payment statuses (data model): `scheduled`, `released`, `settled`, `failed`, `cancelled`. "Approved" is an invoice status and only appears in "Awaiting payment".

## Working demo (in order)

- [x] 1. Sample data: one file of clearly labelled fake payments built from real dataset vendors, users and amounts — every status, failures with reason codes, attempt history, a USD payment, one over $100k, approved-but-unscheduled invoices. Plus `getPayments()` server function that reads it. (30 min)
- [ ] 2. Local helpers (`// TEMP:`): money formatter from cents (USD also shows CAD) and a status badge. (20 min)
- [ ] 3. `/payments` page with the main table: vendor, invoice #, amount + currency, due date, status, released by, empty "Actions" cell. Loads on the server. (45 min)
- [ ] 4. "Sign in as…" page + `getCurrentUser()` (`// TEMP:`, role looked up on the server from the dataset) + header with user, role and "switch user". (45 min)
- [ ] 5. Summary numbers on top: total scheduled this week, released, settled, failed count (red); "Needs Controller" marker on payments over $100k CAD for the signed-in Finance Manager. (30 min)
- [ ] 6. "Needs attention" section for failed payments (reason in plain words + next step) and "Awaiting payment" section for approved-but-unscheduled invoices. (45 min)
- [ ] 7. Payment details with attempt history as a simple list ("Attempt 1: Failed, account closed · Attempt 2: Settled"). (30 min)
- [ ] 8. Filters by status and vendor (URL params, filtered on the server). (30 min)

**Checkpoint (~7pm):** demo works end to end on sample data.

## After the checkpoint

- [ ] 9. UI polish — UI is 20% of the score: spacing, hierarchy, empty states, narrow screens. (~2 h)
- [ ] 10. Connect, as soon as `docs/payment-data.md` is ready (interrupts polish): `git merge Katie`, switch `getPayments()` to the real format, drop the sample file, put the payment session's Schedule/Release/Retry buttons in the Actions cell. (45 min)
- [ ] 11. Run the demo flow (release → fail → fix bank → retry → settled) on the merged app; fix what breaks. (30 min)

## Nice-to-haves (only if time)

- [ ] 12. Role filter / role-specific highlights. (30 min)
