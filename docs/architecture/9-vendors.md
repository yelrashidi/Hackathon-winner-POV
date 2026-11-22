# 9 — Vendor management

**Owner:** Andrew · **Code as of:** `114cc24` (2026-11-21)

## What it does
The company's list of approved suppliers (the **vendor master**) and the controls around it. A new vendor
can't be paid normally until a second person approves it; anyone in finance can freeze a vendor; and a
change of bank details is entered by one person and verified by another. This stops the classic "we
changed banks, please pay this new account" fraud, and stops fake vendors from being added.

Server side only (`src/server/features/vendors/`); the screens are built by the dashboard owner from
`src/contracts/vendor.ts` and `fixtures/vendors/`.

## Who can do what
| Action | AP Clerk | Finance Mgr | Controller | Auditor | Employee / Approver |
|---|---|---|---|---|---|
| View the vendor list and a vendor | ✓ | ✓ | ✓ | ✓ read-only | — |
| Onboard a new vendor | ✓ | ✓ | ✓ | — | — |
| Approve a new vendor | — | ✓ *not the onboarder* | ✓ *not the onboarder* | — | — |
| Put a vendor on hold | ✓ | ✓ | ✓ | — | — |
| Lift a hold | — | ✓ | ✓ | — | — |
| Request a bank change | ✓ | ✓ | ✓ | — | — |
| Verify / reject a bank change | — | ✓ *not the requester* | ✓ *not the requester* | — | — |

- **Who has which role** is in `ACTIONS` (`src/server/core/authorize.ts`). The "not the same person"
  checks need data, so they live in `src/server/features/vendors/rules.ts`.
- **Users who can't act:** anyone on leave or terminated.
- **Every refusal** is a 403 with a reason, and is written to the audit trail as `authz.denied`.
- **Screens get `allowedActions`:** each button comes with `{allowed, reason}`, so the UI can grey it
  out and say why. The server re-checks every action anyway.

## Contract
- **Screens:** `VendorList` / `VendorRow` (screen 1) and `VendorDetail` (screen 2). The detail has the
  vendor fields, bank versions, contracts, POs, invoices, the vendor's audit timeline and `allowedActions`.
- **Inputs:** `OnboardVendorInput` (optional first bank account, optional `fromInvoiceId`),
  `BankDetailsInput`, `StatusChangeInput` (a reason), and `VendorDraft` (the onboarding form prefilled
  from an invoice).
- **Privacy:** a full account number is accepted on input but **never returned**; screens get the last
  4 digits only.
- **Tables:** `vendors` and `vendor_bank_accounts` (already in the schema). **No new columns or
  migration:** who onboarded or approved a vendor, and why it has its current status, are read from
  the append-only `audit_events`.
- **Fixtures:** `fixtures/vendors/` is regenerated with `npx tsx scripts/vendor-fixtures.ts`.

## How it decides
**Vendor status:**
```
onboardVendor        → pending_review                 (+ first bank account, pending)
approveVendor          pending_review → active        second person: not whoever onboarded it
holdVendor             active | pending_review → on_hold     reason required
releaseVendorHold      on_hold → the status before the hold  (a never-approved vendor goes back
                                                               to pending_review, not active)
```

**Bank account versions:** a change is a new row, never an update.
```
requestBankChange    new version, pending          one pending change at a time; 3/5/7–12 digits
verifyBankChange     pending → verified            second person (also a DB CHECK); the old verified → superseded
rejectBankChange     pending → rejected            reason required
```

**Every write runs the same way** (`vendorAction` in `shared.ts`):
1. `authorize()` checks the role.
2. One transaction locks the vendor row, runs the rules, writes the change and writes the audit event.
3. It then **re-runs validation and coding on that vendor's open invoices** (In Review / On Hold). So
   `VENDOR_NOT_ACTIVE`, `BANK_ACCOUNT_UNVERIFIED` and `BANK_DETAILS_MISMATCH` appear or clear on
   their own, with the same request id in the audit trail.

**Onboarding:**
- **Duplicates:** the same GST/HST number (or 9-digit business number), QST number or legal name as
  an existing vendor is refused with `VENDOR_ALREADY_EXISTS`. A shared email domain or a similar name
  is only a warning. This uses validation's own normalisers.
- **Unknown-vendor invoices:** after onboarding, every open unknown-vendor invoice that validation's
  matcher now ties to the new vendor is re-checked, so `VENDOR_UNKNOWN` turns into a match.

**Approvals** (`vendorConflicts`): the vendor's onboarder and approver, and its latest bank change's
requester and verifier, are passed to approvals as `conflicts`. They can't approve that vendor's
invoices; routing goes around them (`src/server/pipeline/approvals.ts`).

## Refusal codes
| Code | Status | When |
|---|---|---|
| `ONBOARDED_IT` | 403 | the person who onboarded a vendor tries to approve it |
| `ENTERED_IT` | 403 | the person who entered bank details tries to verify them |
| `USER_NOT_ACTIVE` | 403 | the actor is on leave or terminated |
| `VENDOR_ALREADY_EXISTS` | 409 | same tax number / legal name as an existing vendor |
| `NOT_PENDING_REVIEW`, `ALREADY_ON_HOLD`, `NOT_ON_HOLD` | 409 | wrong status for the action |
| `CHANGE_ALREADY_PENDING`, `NO_PENDING_CHANGE` | 409 | bank change already waiting / nothing to verify |
| `INVALID_INSTITUTION`, `INVALID_TRANSIT`, `INVALID_ACCOUNT_NUMBER`, `REASON_REQUIRED`, `INVALID_INPUT` | 400 | bad input |
| warnings: `EMAIL_DOMAIN_IN_USE`, `SIMILAR_VENDOR_NAME` | — | onboarding still succeeds; shown to the clerk |

The bank codes and messages match payments' own checks (`features/payments/rules.ts`), so both say the same thing.

## Bad input
- **The same vendor twice:** refused, naming the existing vendor.
- **A clerk approving or verifying their own entry:** refused (403) and audited. A direct SQL UPDATE
  is also stopped by the `two_people` CHECK.
- **Two clicks at once:** the vendor row is locked (`FOR UPDATE`) and new ids are picked under an
  advisory lock, so there is never a duplicate `V057`.
- **Unknown GL account or invoice id:** a 400 with the reason, not a foreign-key crash.
- **A vendor that came with the dataset:** it has no recorded onboarder, so any manager may approve it.

## At 100× volume
- **The list** loads all vendors and joins in code. That's fine at 5,600 vendors; past that, move the
  counts into SQL and page in the query.
- **Re-checking invoices** runs once per open invoice of that vendor, inside the action. A vendor with
  hundreds of open invoices would make a hold slow; we'd queue those re-checks instead.

## Known gaps
- **Bank changes also exist in payments (Katie)**, on Postgres since PR #15. Both write the same
  `vendor_bank_accounts` rows the same way (pending → verified, the old one superseded first, audit
  `bank_account.*` on `V043#3`), and it was verified in both directions on Docker: entered in one,
  verified in the other, the two-people rule holding across both. The screens may call either.
- **No screens yet** (dashboard owner). No editing of vendor fields after onboarding: a change of
  tax number or name would be a new reviewed action, which we cut.
