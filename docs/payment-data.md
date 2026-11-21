# Payment data — what the dashboard can use

**Owner:** Katie (payment session, branch `Katie`) · **Last updated:** 2026-11-21, dashboard connected
**Source of truth:** [`src/contracts/payment.ts`](../src/contracts/payment.ts). Import types from
`@/contracts/payment`, and never redefine them. If this doc and the file disagree, the file wins; tell the payment session.

## Where to get it

Everything is exported from `@/server/features/payments` (server only).

| What | Function | Returns |
|---|---|---|
| All payments the person may see | `listPayments(viewerId: string \| null)` | `PaymentsView` |
| One invoice's payment | `getPaymentDetail(viewerId, invoiceId)` | `PaymentRow \| null` |
| The invoice's audit trail | `getPaymentAudit(viewerId, invoiceId)` | `AuditEvent[]`: `{ id, occurredAt, actorId, onBehalfOf, action, entityType, entityId, invoiceId, before, after, reason }`, oldest first |
| A supplier's bank account versions (last 4 only) | `getSupplierBank(viewerId, vendorId)` | `{ version, status, last4, currency, changedAt, channel, requestedBy, verifiedBy }[]` |
| Failure reasons | `FAILURE_REASONS` from `@/contracts/payment` | message, next step, retry rule, urgency per code |
| Who could release the current payment now | `eligibleReleasers(invoiceId)` | `Person[]` (same rules as release) |
| May this person clear this flag? | `canClearFlag(viewerId, flagId)` | `boolean` (same rule as `clearFlag`) |

**`viewerId` is the signed-in person's user id from the server session**, for example
`(await getCurrentUser())?.id ?? null`, never a value from the browser. `null` returns nothing.

**Actions**: each takes `(actorId, input, opts?)`, where `actorId` comes from the session, and returns
`{ ok: true, value, warnings } | { ok: false, status, reasons: { code, message }[] }`. Show `reasons` in red, as is.

| Action | Input | Who |
|---|---|---|
| `schedulePayment` | `{ invoiceId, payDate? }`. **Retry** = the same call on an invoice whose last attempt failed or was cancelled | AP Clerk, Finance Manager, Controller |
| `releasePayment` | `{ paymentId }` | Finance Manager (≤ $100k CAD), Controller |
| `cancelPayment` | `{ paymentId, reason }` | AP Clerk, Finance Manager, Controller; before release only |
| `simulateSettlement` | `{ paymentId, outcome: "SETTLED" \| FailureCode }` | AP Clerk, Finance Manager, Controller (demo control) |
| `clearFlag` | `{ flagId, note }` | see urgency table |
| `requestBankChange` | `{ vendorId, institution, transit, account }` | AP Clerk, Finance Manager, Controller |
| `verifyBankChange` / `rejectBankChange` | `{ vendorId }` / `{ vendorId, reason }` | Finance Manager, Controller; never whoever entered it (verify) |

**The buttons** are on the dashboard pages and call the server actions in `app/payments/actions.ts`
(the acting person comes from `getCurrentUser()`). `/payments-console` has only the simulated bank's
answer and "Reset demo data". The dashboard reads through `app/payments/_lib/data.ts`, which calls `listPayments` / `getPaymentDetail`.

## Payment statuses and allowed moves

| Status | Means | Can move to |
|---|---|---|
| `scheduled` | clerk set it up, waiting for release | `released`, `cancelled`, `on_hold` |
| `on_hold` | stopped by a **critical** flag on the supplier | `scheduled` (flag cleared), `cancelled` |
| `released` | sent to the (simulated) bank | `settled`, `failed` |
| `settled` | money arrived: final | — |
| `failed` | bank rejected it: final. A retry is a **new attempt** | — |
| `cancelled` | stopped before release, with a reason: final | — |

Code: `PAYMENT_TRANSITIONS` and `canMovePayment(from, to)`.

**Invoice statuses** (`InvoiceRecord.status`), named as in the team's state machine:
`Approved` (no live attempt: never scheduled, or the last attempt failed or was cancelled) ·
`PaymentScheduled` (an attempt is scheduled, on hold or released) · `Paid` (an attempt settled).

## Fields

Money is **integer cents**. Rates are **decimal strings**. Dates are `YYYY-MM-DD`; timestamps are ISO with an
offset (`2026-11-21T15:04:00-05:00`). Amounts are always positive: credit notes are never paid.

### `PaymentsView`: what `listPayments()` returns
| Field | Type | Notes |
|---|---|---|
| `payments` | `PaymentRow[]` | sorted by `current.scheduledDate`, earliest first |
| `awaitingPayment` | `InvoiceRecord[]` | approved invoices with no attempt yet, sorted by `dueDate` |

### `PaymentRow`: one invoice's payment
| Field | Type | Notes |
|---|---|---|
| `invoice` | `InvoiceRecord` | |
| `current` | `PaymentRecord` | the latest attempt |
| `attempts` | `PaymentRecord[]` | every attempt, oldest first (at least 1) |
| `flags` | `PaymentFlag[]` | every flag on any attempt, newest first, open and cleared |
| `releaseCheck` | `ReleaseCheck` | can the **signed-in person** release `current`? |

### `PaymentRecord`: one attempt
| Field | Type | Notes |
|---|---|---|
| `paymentId` | string | |
| `invoiceId` | string | |
| `attemptNo` | integer ≥ 1 | a retry is `attemptNo + 1` |
| `status` | `PaymentStatus` | see table above |
| `method` | `"EFT" \| "CHEQUE" \| "CARD"` | always `"EFT"` for now |
| `currency` | `"CAD" \| "USD"` | |
| `amountCents` | integer > 0 | always the full invoice total, in `currency` |
| `amountCadCents` | integer > 0 | at the invoice-date rate; equals `amountCents` for CAD |
| `fxRateToCad` | decimal string | `"1"` for CAD |
| `scheduledDate` | `YYYY-MM-DD` | the pay date (defaults to the due date; weekend → Friday before) |
| `bankAccount` | `{ vendorId, version, last4 }` | which bank account version it pays; **last 4 digits only** |
| `releasedAt` / `settledAt` / `failedAt` | timestamp \| null | |
| `failure` | `PaymentFailure \| null` | set when `status` is `failed` |
| `cancelledAt` | timestamp \| null | |
| `cancelledBy` | `Person \| null` | |
| `cancelReason` | string \| null | required when cancelled |
| `holdReason` | string \| null | set when `status` is `on_hold` |
| `preparedBy` | `Person` | who scheduled it |
| `releasedBy` | `Person \| null` | |
| `flags` | `PaymentFlag[]` | flags that apply to this attempt: its own, plus its supplier's |

### `InvoiceRecord`
| Field | Type | Notes |
|---|---|---|
| `invoiceId` | string | |
| `vendorInvoiceNumber` | string | the number printed on the invoice |
| `vendorId` / `vendorName` | string | |
| `currency` | `"CAD" \| "USD"` | |
| `totalCents` | integer > 0 | invoice currency |
| `totalCadCents` | integer > 0 | invoice-date rate |
| `dueDate` | `YYYY-MM-DD` | |
| `requestedBy` | `Person` | |
| `approvedBy` | `Person[]` | everyone who signed, across every approval round |
| `status` | `"Approved" \| "PaymentScheduled" \| "Paid"` | |

`Person` = `{ userId: string, name: string }`.

### `PaymentFailure`
`{ code: FailureCode, message, nextStep, retryRule, urgency }`. The text is already filled in from
`FAILURE_REASONS`, so the dashboard shows it as is.

### `PaymentFlag`: urgency flags
| Field | Type | Notes |
|---|---|---|
| `flagId` | string | |
| `urgency` | `"critical" \| "high" \| "low"` | |
| `reasonCode` | `FailureCode` | the bank reason that raised it |
| `message` | string | show as is (texts below) |
| `scope` | `"supplier" \| "payment"` | supplier: every payment to `vendorId`; payment: only `paymentId` |
| `vendorId` | string | |
| `paymentId` | string | the failed attempt that raised it |
| `createdAt` | timestamp | |
| `clearedBy` | `Person \| null` | null while open, or when it cleared itself |
| `clearedAt` | timestamp \| null | **open = `clearedAt` is null** |
| `clearNote` | string \| null | required for critical and high, optional for low |
| `clearedAutomatically` | boolean | true when it cleared itself |

### `ReleaseCheck`
`{ allowed: boolean, reasons: { code, message }[] }`. When `allowed` is false, show **every** reason
in red, as is. Codes (`src/server/features/payments/rules.ts`):

| Code | When |
|---|---|
| `NOT_SIGNED_IN` | nobody picked in "Viewing as" |
| `ROLE_CANNOT_RELEASE` | not Finance Manager or Controller |
| `NOT_ACTIVE` | on leave or no longer with the company |
| `NOT_SCHEDULED` / `ON_HOLD` | payment isn't scheduled / is on hold |
| `SUPPLIER_FRAUD_HOLD` | open critical flag on the supplier |
| `METHOD_NOT_SUPPORTED` | not EFT |
| `CREDIT_NOTE` | negative invoice |
| `FX_MISMATCH` | amount × rate ≠ stored CAD amount (±1¢) |
| `OVER_RELEASE_LIMIT` / `NO_RELEASE_POLICY` | Finance Manager over the P09 limit / no P09 policy |
| `APPROVED_IT` / `SCHEDULED_IT` / `REQUESTED_IT` | separation of duties (P11, Q5, Q6) |
| `NOT_APPROVED` / `PAYEE_MISMATCH` / `AMOUNT_OVER_APPROVED` | pay only what was approved |
| `VENDOR_UNKNOWN` / `VENDOR_NOT_ACTIVE` | supplier not in master / pending review or on hold |
| `BANK_ACCOUNT_MISSING` / `BANK_ACCOUNT_CLOSED` / `BANK_NOT_VERIFIED` / `BANK_CURRENCY_MISMATCH` | the account it pays |
| `BANK_CHANGE_PENDING` | the supplier has a bank change nobody verified yet |
| `BLOCKING_FLAG` | an open `block` flag from validation or duplicates |

## Failure reasons (`FAILURE_REASONS`)

| Code | Retry rule | Urgency | Message | Next step |
|---|---|---|---|---|
| `BANK_ERROR` | `RETRY_ALLOWED` | low | The bank had a temporary error and did not process the transfer. | Retry the payment. |
| `INSUFFICIENT_FUNDS` | `RETRY_ALLOWED` | low | Harborline's account did not have enough funds when the transfer ran. | Confirm funds are available, then retry. |
| `ACCOUNT_CLOSED` | `FIX_BANK_DETAILS` | high | The supplier's bank account is closed. | Get new details from the supplier's contact on file, and have a second person verify them before retrying. |
| `INVALID_ACCOUNT` | `FIX_BANK_DETAILS` | high | The account number does not exist at the supplier's bank. | Correct and verify the supplier's bank details, then retry. |
| `INVALID_BRANCH` | `FIX_BANK_DETAILS` | high | The transit (branch) number is not valid. | Correct and verify the supplier's bank details, then retry. |
| `NAME_MISMATCH` | `FIX_BANK_DETAILS` | high | The account holder's name does not match the supplier's legal name. | Confirm the account belongs to the supplier and verify it, then retry. |
| `CURRENCY_NOT_SUPPORTED` | `FIX_BANK_DETAILS` | high | The supplier's account cannot receive this currency. | Get and verify an account that accepts this currency, then retry. |
| `ACCOUNT_FROZEN` | `FIX_BANK_DETAILS` | high | The supplier's account is frozen by their bank. | Get new bank details from the supplier and have a second person verify them before retrying. |
| `FRAUD_HOLD` | `ESCALATE` | critical | The bank held the transfer as possible fraud. | All payments to this supplier are stopped. The Controller reviews and clears the hold before any retry. |

## Urgency flags: what each level does

| Level | Raised by | Applies to | Effect | Cleared by | Note | Message |
|---|---|---|---|---|---|---|
| **critical** | `FRAUD_HOLD` | the supplier | every scheduled and new payment to the supplier is `on_hold`; release refuses | Controller role only (Controller or CFO), never whoever scheduled the payment | required | release shows *"Stopped: fraud hold on this supplier. Controller must review."* |
| **high** | `ACCOUNT_FROZEN`, `ACCOUNT_CLOSED`, `INVALID_ACCOUNT`, `INVALID_BRANCH`, `NAME_MISMATCH`, `CURRENCY_NOT_SUPPORTED` | the supplier | review flag on its other payments; the flag doesn't block, but the failed bank account is no longer payable, so release to it is refused | automatically when new bank details are verified, or AP clerk / Finance Manager / Controller | required | *"Review: a payment to this supplier failed (Account closed) on 2026-11-21."* |
| **low** | `BANK_ERROR`, `INSUFFICIENT_FUNDS` | the failed payment only | none on other payments | automatically when the retry is scheduled, or AP clerk / Finance Manager / Controller | not needed | *"Last attempt failed: Bank error. Retry when ready."* |

When a critical flag clears, its `on_hold` payments go back to `scheduled` (they still need a release).
Nobody else (employee, approver, auditor) can clear a flag; the server refuses. Every flag
created and cleared is in the audit trail.

**Dashboard display (Katie's spec):** sort "Needs attention" by urgency, critical first. Show counts
at the top, e.g. "1 critical · 3 high · 2 low", counting **open** flags. Badge colours: critical red,
high amber, low grey.

## Who sees what

Follows [`roles-and-permissions.md`](architecture/roles-and-permissions.md). Filtering happens on the server:

| Role | Sees |
|---|---|
| Employee | payments for invoices they requested |
| Approver | payments for their department's invoices |
| AP Clerk, Finance Manager, Controller | all payments |
| Auditor | all payments, read only |

Bank account numbers only ever appear as `last4`. The full number never reaches the browser.
Bank account `status` is `pending`, `verified`, `rejected`, `superseded` or `closed` (a payment to it failed with a bank-detail reason).

## Example

A real scheduled payment from the dataset (`payments.csv` PAY-00386, invoice AP-00394), as
`listPayments()` returns it to the Finance Manager. It passes `PaymentsView.parse`.

```json
{
  "payments": [
    {
      "invoice": {
        "invoiceId": "AP-00394",
        "vendorInvoiceNumber": "000804",
        "vendorId": "V011",
        "vendorName": "Summit Packaging Supply",
        "currency": "CAD",
        "totalCents": 245719,
        "totalCadCents": 245719,
        "dueDate": "2026-11-02",
        "requestedBy": { "userId": "U019", "name": "Stefan Haddad" },
        "approvedBy": [{ "userId": "U007", "name": "Dev Malhotra" }],
        "status": "PaymentScheduled"
      },
      "current": {
        "paymentId": "PAY-00386",
        "invoiceId": "AP-00394",
        "attemptNo": 1,
        "status": "scheduled",
        "method": "EFT",
        "currency": "CAD",
        "amountCents": 245719,
        "amountCadCents": 245719,
        "fxRateToCad": "1",
        "scheduledDate": "2026-11-02",
        "bankAccount": { "vendorId": "V011", "version": 1, "last4": "8394" },
        "releasedAt": null,
        "settledAt": null,
        "failedAt": null,
        "failure": null,
        "cancelledAt": null,
        "cancelledBy": null,
        "cancelReason": null,
        "holdReason": null,
        "preparedBy": { "userId": "U005", "name": "Sam Patel" },
        "releasedBy": null,
        "flags": []
      },
      "attempts": ["… the same object as current …"],
      "flags": [],
      "releaseCheck": { "allowed": true, "reasons": [] }
    }
  ],
  "awaitingPayment": []
}
```

**Format example only (not in the dataset):** if that attempt had failed with `ACCOUNT_CLOSED`, it would
carry `"status": "failed"` and this `failure`, and a high flag would appear on the supplier's payments:

```json
"failure": {
  "code": "ACCOUNT_CLOSED",
  "message": "The supplier's bank account is closed.",
  "nextStep": "Get new details from the supplier's contact on file, and have a second person verify them before retrying.",
  "retryRule": "FIX_BANK_DETAILS",
  "urgency": "high"
}
```

## What changes for the dashboard's TEMP types

Compared with `app/payments/_lib/types.ts` on the `dashboard` branch:
- `InvoiceRecord.status` is now `"Approved" | "PaymentScheduled" | "Paid"` (was `approved` / `payment_scheduled` / `paid`).
- `failureCode` is now `failure: PaymentFailure | null`, with the text filled in. `failure-reasons.ts`
  can import `FAILURE_REASONS` instead of keeping a copy. The groups are now `RETRY_ALLOWED` /
  `FIX_BANK_DETAILS` / `ESCALATE` (were `retry` / `fix_bank_details` / `escalate`), and `ACCOUNT_FROZEN` moved to `FIX_BANK_DETAILS`.
- New on `PaymentRecord`: `bankAccount`, `cancelledAt`, `cancelledBy`, `flags`.
- New on each row: `flags`, `releaseCheck`. The dashboard's TEMP copy of the release rules can go once
  step 3 lands.
