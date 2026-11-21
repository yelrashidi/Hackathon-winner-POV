# Payments to-do (deadline: today 8pm)

- [x] **1. Statuses & data shape** (30m): The payment's states (Approved → Scheduled → Released → Settled/Failed) and which moves are allowed. Write `docs/payment-data.md` so the dashboard knows the format, including urgency flags.
  - Done 2026-11-21: statuses, allowed moves, record shapes, failure reasons and urgency in `src/contracts/payment.ts`; dashboard guide in `docs/payment-data.md`.
- [x] **2. Sample data** (30m): Approved invoices, vendors (some with unverified bank changes), users with roles. Enough to cover every demo case.
  - Done 2026-11-21: open work loaded from the dataset CSVs (`src/server/features/payments/fake-data/`); adapters in `deps.ts`.
- [x] **3. Release rules** (60m): One function: "Can this person release this payment? If not, why?" Covers separation of duties (whoever requested, approved or scheduled it can't release it), the $100k limit, verified bank, duplicates, credit notes, USD→CAD for the limit check, payee/amount must match what was approved, and Critical urgency flags. The heart of the presentation.
  - Done 2026-11-21: `checkRelease()` and schedule/cancel/flag/bank checks in `src/server/features/payments/rules.ts`.
- [x] **4. Tests for the rules** (30m): One test per rule, so we can say "every policy is tested."
  - Done 2026-11-21: `__tests__/rules.test.ts` (one per rule) + `__tests__/flow.test.ts` (dataset end to end); 36 tests.
- [x] **5. Schedule + Release + Cancel actions** (65m): The server actions that use the rules and change the status. Cancel only before release, with a reason.
  - Done 2026-11-21: `src/server/features/payments/service.ts`, exported from `index.ts`.
- [x] **6. Fake bank (EFT module)** (30m): Simulated EFT behind a swappable interface, with a "simulate settlement" button that can settle or fail. Failures create urgency flags; minimum bank change + second-person verify (TEMP: vendors).
  - Done 2026-11-21: `bank.ts` (`EftRail` / `SimulatedEft`); failures, urgency flags and bank change/verify in `service.ts`.
- [x] **7. Audit trail entries** (20m): Every action logged with who, what and when, including flags created and cleared.
  - Done 2026-11-21: every action writes an audit event (`deps.ts` `emitAudit`); `getPaymentAudit()`.
- [x] **8. UI** (60m): Schedule/Release buttons, plus the red "can't release because…" message.
  - Done 2026-11-21: buttons on the dashboard pages (`app/payments/actions.ts`, `_components/ActionForm.tsx`, `ActionsSpot.tsx`); `/payments-console` = simulated bank + reset.
- [ ] **9. Demo run-through** (30m): Happy path, 3 blocked cases, 1 failed payment. Fix what breaks.
  - Automated 2026-11-21: `flow.test.ts` runs the happy path, the blocked cases and the failed-payment flow on the dataset. Manual click-through in the browser: still to do.
- [ ] **10. Presenter notes polish** (20m): Turn `payment-decisions.md` into talking points plus likely judge questions.
- [ ] **11. Connect to teammates' code** (30–60m): for each item in `payment-assumptions.md`, swap the adapter to the real implementation, run tests, fix mismatches.
  - Approvals done 2026-11-21 (Youssef's store + seed). The rest waits on owners: see `payment-assumptions.md`.

**Nice-to-have (only if time):** cheque fallback, card payments, batch payments, Stripe adapter.

**Cut line:** if behind at 5pm, skip polish on step 8 and go straight to step 9. Rules, tests and a working demo matter more than pretty buttons.
