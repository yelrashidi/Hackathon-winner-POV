# Payments — what we assume from other features

**Owner:** Katie · **Checked against branches:** `origin/main`, `origin/Youssef`, `origin/andrew`,
`origin/arpan/*` on 2026-11-21. `origin/Youssef` @ `90dc21c` merged into `Katie` on 2026-11-21 (merge not
committed yet). **Re-checked 2026-11-21 13:30:** `origin/Youssef` @ `5f1a907`, `origin/andrew` @ `ccdda10`,
`origin/arpan/remove-root-data` @ `51a0322`, local `dashboard` @ `8ebda63` + uncommitted work. None of these is merged yet.

Payments is built before its dependencies exist. Each dependency sits behind **one adapter
function** in `src/server/features/payments/deps.ts` (built 2026-11-21); payment logic calls only the adapter.
Since 2026-11-21 the adapters read the database (`fake-data/` is deleted). Every temporary piece
left is marked `// TEMP: <feature>`; find them with `grep -rn "TEMP:" src/`. Step 11 of [`payment-todo.md`](payment-todo.md) swaps each adapter to the real thing.

Shapes below come from [`architecture/data-model.md`](architecture/data-model.md),
[`architecture/roles-and-permissions.md`](architecture/roles-and-permissions.md) and, where it
exists, the teammate's actual code.

## Still TEMP — and who each is waiting on (2026-11-21)

`grep -rn "TEMP:" src/ app/` finds every one in code. **Done 2026-11-21 (payments on the database):** approvals through
`PostgresApprovalStore` (seed deleted), database + transactions, `fire()`, `authorize()`, audit through `withAction`.

| TEMP piece | Where in our code | Waiting on | Owner |
|---|---|---|---|
| Stored validation / duplicate flags | `deps.ts` `loadOpenInvoiceFlags` reads open `invoice_flags` rows directly | an exported reader from validation (duplicates stores its flags since Arpan's branch) | Andrew |
| Release-time bank check | release rules check our own bank versions | Andrew's planned `validateBankForRelease` (not on main yet) | Andrew |
| Money helpers | `money.ts` (`formatMoney`, `cadMatches`) | `core/money.ts` (Andrew has money helpers inside validation, not exported) | foundation: no owner |
| Vendors + bank accounts, bank change/verify | `deps.ts` reads and writes `vendor_bank_accounts` | feature 9 | 9 Vendors: no owner |
| Login / signed-in person | `getCurrentUser()` in `src/server/session/` (cookie `hl_viewing_as`), used by `app/payments/actions.ts` and the pages | real session + role switcher | foundation: no owner |
| Upload: extraction call | `app/payments/_lib/extraction-adapter.ts` | 2 Extraction | no owner |
| Upload: confirmed uploads | `app/payments/_lib/upload-store.ts` (in memory) | database | schema owner: not named |
| Departments / tax codes for the upload form | `app/payments/_lib/reference-data.ts` (CSV) | seeded tables | schema owner: not named |
| Dashboard money and date formatting | `app/payments/_lib/format.ts` | `core/money.ts` | foundation: no owner |

## Summary

**Updated 2026-11-21:** A1–A4, A7–A9 and A11 are real (database, `fire()`, `authorize()`, `withAction`), and A5 reads
stored `invoice_flags`. The rows below record what we assumed before they existed.

| # | Dependency | Feature · owner | Exists today? | Adapter | Risk |
|---|---|---|---|---|---|
| A1 | Approval plans + `approversOf()` | 6 Approvals · Youssef | `approversOf()` real (merged). **Plan store real on `origin/Youssef` @ `a896a64`, not merged** | `getApprovalPlans(invoiceId)` | low |
| A2 | Users, roles, status | 6 Approvals (`DirectoryUser`) + foundation | **Type real** (merged); data still fake | `getUser(userId)` | low |
| A3 | Release policies P09–P11 | 6 Approvals · Youssef | **Real** (merged): `policiesFromCsv()` → `release_by` / `release_not_approver` | `getReleasePolicies()` | low |
| A3b | Approval `basis` (approved payee + amount) | 6 Approvals · Youssef | **Real** (merged): `ApprovalPlan.basis` | read from the plan | low |
| A4 | Invoice | foundation / schema · _no owner_ | No | `getInvoice(invoiceId)` | low |
| A5 | Invoice flags (validation, duplicates) | 4 Validation · **Andrew**; 5 Duplicates · _no owner_ | Shape real (merged). Validation flags real on `origin/andrew`, returned not stored. Duplicates: nothing | `getOpenFlags(invoiceId)` | medium — see R4 |
| A6 | Vendor + bank account versions | 9 Vendors · _no owner_ | Shape partly real: Andrew's `BankAccountVersion` (`origin/andrew`) | `getVendor()`, `getBankAccount()`, bank change/verify | **high** — see R5, R9 |
| A7 | `fire(invoiceId, event, actor)` | foundation · _no owner_ | No | `fireInvoiceEvent()` | **high** — see R3 |
| A8 | `authorize(actor, action, resource)` | foundation · _no owner_ | No | `authorizeAction()` | **high** — see R2 |
| A9 | Audit `emit(tx, event)` | 8 Audit / foundation · _no owner_ | No | `emitAudit()` | low |
| A10 | Session: current user | foundation · built by Katie's **dashboard session** | Real but uncommitted: `getCurrentUser()` in `src/server/session/` (local `dashboard` worktree) | `getCurrentActor()` | medium — see R10 |
| A11 | Database + transactions | foundation / schema · _no owner_ | No | in-memory store in `fake-data/` | medium — resets on restart |
| A12 | Bank check at release | 4 Validation · Andrew | **Planned, not built**: `validateBankForRelease` (his STATUS "Next"); his `bankRule` says "Payments (7) re-runs this at release" | `checkBankForRelease(invoiceId)` | medium |

## Shapes we assume

### A1 Approvals (Youssef) — real since 2026-11-21
- `deps.ts` `getApprovalFacts(invoiceId)` calls his `getApprovalPlans(invoiceId)` (every plan, oldest first)
  → `approversOf(...plans)` for P11, and `getCurrentApprovalPlan(invoiceId, { invoiceVersion }).basis` for R7.
  No current plan for the invoice's version → release refuses `NOT_APPROVED`.
- **Since 2026-11-21:** read through `PostgresApprovalStore`; the database seed loads `approvals.csv` into `approval_plans`.
  Payments' own seed (`fake-data/approval-seed.ts`) is deleted. His files are unchanged.

### A2 Users (Youssef's `DirectoryUser`, `src/server/features/approvals/directory.ts:20`) — type real
`{ id, fullName, role: "employee"|"ap_clerk"|"approver"|"finance_manager"|"controller_admin"|"auditor", departmentId, managerId, approvalLimitCents, status: "active"|"on_leave"|"terminated"|string, statusSince, delegateId }`
- Any status other than the three (e.g. `suspended`) means unavailable — we treat it as "cannot release".
- Used by: release rules (role, active), schedule (role), UI names.

### A3 Release policies (Youssef's `ApprovalPolicy`, `ruleType: "payment_release"`)
`{ id: "P09", conditions: { kind: "amount_up_to", cadCents: 10000000 }, steps: { type: "release_by", role: "finance_manager" } }`, same for P10 (`amount_over`) and P11 (`release_not_approver`).
- Used by: release rules — the $100k limit is read from policy, never hard-coded.

### A4 Invoice (data-model.md `invoices`)
```ts
{ id: string; version: number; status: InvoiceStatus; vendorId: string; invoiceNumber: string;
  invoiceDate: string /* ISO */; dueDate: string | null; currency: "CAD" | "USD";
  totalCents: number /* invoice currency, negative for credit note */; totalCadCents: number;
  fxRate: string /* decimal, invoice-date rate */; isCreditNote: boolean;
  requesterId: string; submittedBy: string | null }
```
- `InvoiceStatus` = the states in [`explainers/brim-ap-diagrams.md`](explainers/brim-ap-diagrams.md).
- Used by: schedule (must be `Approved`), release rules (CAD limit, credit note), dashboard.

### A5 Flags (shared `Flag` contract, `src/contracts/flag.ts`)
`{ code, severity: "block"|"warn"|"info", message, evidence, relatedInvoiceId?, relatedCardTxnId?, status: "open"|"resolved"|"overridden" }`
- **Assumed:** `getOpenFlags(invoiceId): Flag[]`, re-read at release time. Validation returns flags but
  does not store them yet (Andrew's STATUS: "persist to `invoice_flags`" is next).
- Validation's codes are named in `src/server/features/validation/codes.ts` (`origin/andrew`). Bank codes:
  `BANK_DETAILS_MISMATCH` and `BANK_ACCOUNT_UNVERIFIED` are `block`, `BANK_RECENTLY_CHANGED` is `warn`.
- Payments **writes** flags too (`PAYMENT_FAILED`, `BANK_ACCOUNT_ON_HOLD`), through an assumed `addFlag(invoiceId, flag)`.
- Used by: release rules (duplicates / any open `block` flag), failure handling.

### A6 Vendors + bank accounts (data-model.md `vendors`, `vendor_bank_accounts`)
Field names follow Andrew's `BankAccountVersion` (`src/server/features/validation/context.ts:33`,
`origin/andrew`), so validation and payments read one shape. The last four fields are ours; his type doesn't have them (R9).
```ts
Vendor = { id; legalName; status: "active"|"pending_review"|"on_hold"|string; preferredPaymentMethod: "EFT"|"CHEQUE"|"CARD" }
BankAccountVersion = { vendorId: string; version: number; status: "pending"|"verified"|"rejected"|"superseded";
  institution: string | null; transit: string | null; account: string | null; last4: string;
  changedAt: string | null; channel: string | null;          // Andrew's fields
  currency: "CAD"|"USD";                                     // ours: decided 2026-11-21, in data-model.md
  requestedBy: string | null; verifiedBy: string | null; verifiedAt: string | null }  // ours: two-person rule
```
- A version is identified by `vendorId` + `version` (Andrew's type has no `id`).
- **Payments adds status `closed`** (a payment to it failed with a bank-detail reason, so it is not payable) and `closedReason`. Feature 9 must keep it, or give us another way to say "not payable".
- "Changed, not verified" = `status: "pending"`. A change is a new row, never an update.
- **Assumed:** `getPayableBankAccount(vendorId)` = the single `verified` row; `requestBankChange()`, `verifyBankChange()`.
- Used by: release rules (verified bank), failure handling, retry.

### A7 `fire(invoiceId, event, actor)`
Events payments fires (from the state diagram): `schedule` (Approved → PaymentScheduled),
`paymentSettled` (→ Paid), `paymentFailed` / `paymentCancelled` (→ Approved). Throws on an illegal transition.

### A8 `authorize(actor, action, resource)`
Throws `Forbidden(reason)`. Actions payments needs: `payment.schedule`, `payment.release`,
`payment.simulateSettlement`, `payment.retry`, `bank.requestChange`, `bank.verifyChange`.

### A9 Audit `emit(tx, event)` (data-model.md `audit_events`)
`{ occurredAt, actorId, onBehalfOf, action, entityType, entityId, invoiceId, before, after, reason }`

### A10 Session
`getCurrentActor(): { userId: string; role: UserRole }` from the server session, never from the request body.
- **Exists, uncommitted**, in Katie's dashboard worktree: `getCurrentUser(): Promise<DirectoryUser | null>`
  (`src/server/session/current-user.ts`), cookie `hl_viewing_as` = a user id, role looked up on the server.
  Its own comment says the payment session should read the signed-in person through it. Today
  `app/payments-console/` reads the same cookie (`// TEMP: session`); swap for `getCurrentUser()` at merge.

### A12 Bank check at release (Andrew, planned) — not used yet
`validateBankForRelease(...)`: signature not written yet. Until it lands, our adapter checks only that
the payment goes to the vendor's single `verified` account. **Don't build a second copy of his remit-to comparison.**

## Risky assumptions — check with the team now

- ~~**R1 Bank account currency.**~~ **Decided 2026-11-21:** `vendor_bank_accounts.currency`
  (`CAD`/`USD`) added to [`data-model.md`](architecture/data-model.md). The seed must fill it
  (dataset has no such column: default `CAD` — every vendor with bank details is Canadian; the 4 US vendors that bill in USD have no bank details and are paid by card).
  Schema owner and feature 9 owner need to know.
- **R2 Where separation of duties lives (foundation).** The docs say it lives in `authorize()`.
  Our release rules function implements P09–P11. Proposal: `authorize("payment.release")` calls
  payments' `canRelease()`, so the rule exists once. Agree this with whoever builds `authorize()`.
- **R3 Hold states in `fire()` (foundation).** Our design puts payments on hold when a bank account
  fails, and escalates fraud holds. The state diagram has no "hold at release time" — it is an open
  P0 gap in `TODO.md`. We keep holds on the **payment** (payment status), and the invoice stays
  `PaymentScheduled` / `Approved`. Whoever builds `fire()` must not add a conflicting invoice-level hold.
- **R4 Duplicate flags (features 4, 5).** We block release on **any open flag with severity `block`**
  rather than on specific codes. Validation (Andrew) has now named its codes, and its bank codes are `block`, so this
  works for them. Duplicates still has no owner: it must emit confirmed duplicates as `block`, and
  re-check at release time (diagram: "re-checked at release").
- **R5 Vendors has no owner (feature 9) — decided 2026-11-21:** payments builds the minimum (bank status,
  enter new details, verify by a second person) with fake data, marked `TEMP: vendors`.
- ~~**R6 Approval plans are not persisted.**~~ **Solved by Youssef** (`a896a64`, store.ts): returns every plan, oldest first, as we asked. Needs merging into `Katie`.
- **R7 Payee and amount must match the approval — decided 2026-11-21: yes, a release rule in step 3.**
  Release refuses if the payment's vendor ≠ `basis.vendorId`, or amount > `basis.totalCents` in
  `basis.currency` (Youssef's `ApprovalPlan.basis`, `src/contracts/approvals.ts:228`).
- **R8 Two owners for Payments.** Youssef's branch lists **him** as the 7 Payments owner (`docs/STATUS.md`
  team table + "### 7 Payments — Youssef", `docs/todo/TODO.md` "## 7 Payments — owner: Youssef"). Katie's
  claim is uncommitted, so he hadn't seen it. **Katie to settle with Youssef before merging his latest**
  (`docs/STATUS.md` will conflict). His Payments section lists 5 lessons from his bugs (BUG-Youssef-01…05) that apply
  to our release rules either way.
- **R9 Bank account shape is missing the two-person fields.** Andrew's `BankAccountVersion` has no
  `requestedBy` / `verifiedBy` / `currency`. The two-person verification rule and `CURRENCY_NOT_SUPPORTED` need
  them. Ask Andrew, or whoever takes feature 9, to add them to the shared shape.
- **R10 Two copies of `DirectoryUser`.** The dashboard session's `src/server/session/users.ts` redefines it
  (adds `title`, loosens `status`) instead of importing Youssef's (`approvals/directory.ts`). Both sides
  should import one type, or a field rename on one side silently breaks the other.
- **R11 Merging Andrew's branch conflicts.** `origin/andrew` is a standalone TypeScript project with no Next.js. Merging
  it into `Katie` conflicts in `package.json`, `package-lock.json`, `tsconfig.json`. `origin/Youssef` +
  `origin/andrew` conflict in 6 files (`docs/STATUS.md`, `fixed-bugs.md`, `money-and-tax.md`, `TODO.md`,
  `tasks-completed.md`, `src/contracts/flag.ts`; Andrew has an older copy of Youssef's `flag.ts`). Best fixed
  by them merging to `main` through a PR, then everyone pulling `main`.
