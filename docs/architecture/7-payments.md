# 7 — Payments

**Owner:** Katie (STATUS: Youssef also listed, to confirm) · **Code as of:** `4881290`

Detail lives in two places: what each field and code means is in [`payment-data.md`](../payment-data.md), and why each rule exists is in [`payment-decisions.md`](../payment-decisions.md). What's still TEMP is in [`payment-assumptions.md`](../payment-assumptions.md).

## What it does
It takes an **Approved** invoice, one person schedules a payment, and a *different* person with enough authority releases it to the vendor's *verified* bank account. A simulated EFT bank then settles it or fails it with a reason. Invoice events: schedule → `PaymentScheduled`, settle → `Paid`, fail or cancel → back to `Approved` (`deps.ts` `fireInvoiceEvent`, TEMP until `core/fire.ts`). A retry is always a **new attempt**, and final states never change.

## Contract
- Shared schemas: `src/contracts/payment.ts`, which holds `PaymentRecord` (:187), `PaymentFlag` (:156), `ReleaseCheck` (:235), `PaymentsView` (:258) and `FAILURE_REASONS` (:83).
- Reads: `listPayments(viewerId)` and `getPaymentDetail(viewerId, invoiceId)` (`service.ts:203`, `:222`).
- Actions: `schedulePayment`, `releasePayment`, `cancelPayment`, `simulateSettlement`, `clearFlag`, and `requestBankChange` / `verifyBankChange` / `rejectBankChange` (`service.ts:282`–`:547`).
  - Every action returns `{ ok: true, value, warnings }` or `{ ok: false, status, reasons[] }`.
  - The actor always comes from the server session.
- Stored: in memory (`fake-data/store.ts`, TEMP: db). Fixtures: none yet, because no later stage reads payments.

## How it decides
All the rules are pure functions in `rules.ts`. The service loads the facts, calls a rule, and only writes if the rule returns no reasons. Every write also writes an audit event.
- **Release** (`checkRelease`, `rules.ts:97`) returns *every* reason that applies, not just the first:
  - Role: Finance Manager or Controller, and active today.
  - P09 limit, read from the policy (Finance Manager up to $100k CAD).
  - P11 and separation of duties: the approver (`approversOf` over every approval round), the scheduler and the requester can't release.
  - Bank account: verified, not closed, and the same currency; a pending bank change blocks.
  - Payee and amount must match the approval `basis`.
  - FX: amount × rate must equal the stored CAD amount to ±1¢.
  - No open `block` flag; credit notes are never paid; EFT only; the vendor must be active.
- **Schedule** (`checkSchedule`, `:246`): finance roles only. After a failure, the failure's retry rule decides whether a retry is allowed. The default pay date is the due date, moved to the Friday before if it falls on a weekend (or the next Monday if that Friday has passed), and an overdue date becomes today (`defaultPayDate`, `:416`).
- **Bank answer** (`simulateSettlement`, `service.ts:387`) only works on a released payment. One lookup in `FAILURE_REASONS` gives each failure its retry rule and its urgency. Urgency decides how far the problem spreads:
  - **Critical** holds every payment to the supplier.
  - **High** closes the bank account.
  - **Low** affects only that payment.
- No LLM anywhere: every verdict is deterministic code.

## Flags it raises
Payment flags (`PaymentFlag`) come from bank failures, not from invoice validation. Release refusals are reasons, not flags; their codes are listed in `payment-data.md`.

| Code | Severity | Fires when | Message example |
|---|---|---|---|
| `FRAUD_HOLD` | critical | the bank holds a transfer as possible fraud | *Stopped: fraud hold on this supplier. Controller must review.* |
| `ACCOUNT_CLOSED`, `ACCOUNT_FROZEN`, `INVALID_ACCOUNT`, `INVALID_BRANCH`, `NAME_MISMATCH`, `CURRENCY_NOT_SUPPORTED` | high | the supplier's account can't receive the payment | *Review: a payment to this supplier failed (Account closed) on 2026-11-21.* |
| `BANK_ERROR`, `INSUFFICIENT_FUNDS` | low | a temporary problem on the bank's side or ours | *Last attempt failed: Bank error. Retry when ready.* |

How each flag clears:
- **Critical:** only the Controller can clear it, never the scheduler, and a note is required.
- **High:** clears automatically once new bank details are verified, or finance clears it with a note.
- **Low:** clears automatically when the retry is scheduled.

## Bad input
- **USD invoice:** the FX check runs again at release, and the bank account's currency must match the payment.
- **Credit note (negative total):** refused with `CREDIT_NOTE`. We never pay out a credit.
- **Unknown or inactive vendor, or no bank account:** release is refused (`VENDOR_UNKNOWN`, `VENDOR_NOT_ACTIVE`, `BANK_ACCOUNT_MISSING`).
- **Pay date in the past:** refused (`PAY_DATE_IN_PAST`).
- **Bad bank numbers:** a change is refused if the institution isn't 3 digits, the transit isn't 5 digits or the account number isn't 7–12 digits.
- **Empty cancel reason or empty fraud-clearing note:** refused (`REASON_REQUIRED`, `NOTE_REQUIRED`).
- **Unknown bank outcome:** HTTP 400.
- **Nobody signed in:** `NOT_SIGNED_IN`.
- **Someone posting the action as the wrong role:** the same refusal the screen shows, because the check runs on the server.

## At 100× volume
- **The in-memory store goes first.** It is lost on restart and limited to one process. It moves to Postgres, with each action in one transaction alongside `fire()` and the audit write.
- **`listPayments` is slow at scale.** It builds every row and runs `checkRelease` for each one. It would page through the rows and run the release check only for the rows on screen.
- **The simulated bank answers immediately.** A real EFT rail is batch files with answers arriving later, so release would send the payment with an idempotency key and the bank's answer would come back through a webhook.

## Known gaps
- **Not handled:**
  - Statutory holidays: only weekends move the pay date.
  - Delegation for release.
  - Partial payments.
  - Card, cheque and wire payments.
- **Duplicates aren't caught yet.** The `getOpenInvoiceFlags` stub returns nothing, so a duplicate scheduled twice (AP-00394 / AP-00407 in the dataset) isn't blocked until duplicate flags are stored.
- **Built on TEMP stand-ins:** `authorize()`, `fire()` and audit are stand-ins inside payments. Approvals history comes from a seed until Youssef's flow fills his store.
