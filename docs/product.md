# Product — what we are building

Source of truth for scope: the brief (`Brim Hackathon Brief - AP Automation for Business Cards.docx`).
Plain-language domain primer: [`Brim_AP_Automation_Challenge_Explained.md`](explainers/Brim_AP_Automation_Challenge_Explained.md).
This file answers one question: **is X in scope, and what does done look like?**

## How we are judged — and what that means for every decision

| Criterion | Weight | So we… |
|---|---|---|
| Required features | 40% | build general logic; scored on a **hidden batch** of invoices, so nothing keyed to sample data |
| Technical depth (live Q&A) | 25% | keep each feature small enough that all four of us can explain it; every feature doc has a *100× volume* section |
| UI | 20% | give each role its own screen; every flag says what is wrong with the numbers in it |
| Bonus | 15% | only after features 1–9 work end to end; one deep bonus beats five shallow ones |

## Required features

Status values: `planned` · `in progress` · `works` (end to end on the golden set) · `cut`.

| # | Feature | Done means | Status |
|---|---|---|---|
| 1 | **Invoice intake** | Upload a PDF/image, or ingest the AP inbox; each invoice attachment becomes a draft bill. Emails that are not invoices (receipts, spam, "thanks for paying") are classified and kept out of the bill queue, with the reason shown. Emails with no attachment are routed, not dropped. | planned |
| 2 | **Data extraction** | PDFs and scanned images, English and French. Captures vendor, invoice number, dates, line items, currency and **each tax amount mapped to a tax code**. Low confidence or failure lands in manual entry, never a silent guess. | planned |
| 3 | **Smart coding** | Each line gets a suggested GL account and department learned from ~450 historical invoices, with the reason (`12 of the last 12 Speedy Tires lines → 6100`). A person accepts or changes each. | planned |
| 4 | **Validation and matching** | Vendor master (known, active, not on hold), contract (rate caps, spend limits, end dates), PO (exists, open, amount and quantity), tax vs **province of delivery**, arithmetic. Each discrepancy is a flag before payment. | planned |
| 5 | **Duplicate detection** | Exact, near-exact and reformatted duplicates (`ST-4471` vs `ST4471`, shifted dates), and invoices **already paid by Brim card**. Shows the matching record side by side. | planned |
| 6 | **Approval workflow** | Routes by amount (in CAD), department, vendor status and policy. Admin edits rules. Delegation and absence handled, and recorded as delegate actions. Invoice, coding and approval history on one screen. | planned |
| 7 | **Payments** | Schedule and release simulated EFT; release limits by role; payments dashboard with a status per payment; separation of duties enforced at release. | planned |
| 8 | **Audit trail** | Every action: who, when, on whose behalf, before and after. Each payment links back to invoice, approval chain and GL codes in one audit-ready view; auditor can export. | planned |
| 9 | **Vendor management** | Vendor master view, onboard a new vendor, hold unapproved ones, and **bank-detail change as a controlled action** (requested by one person, verified by another). | planned — *see note* |

> **Feature 9 is required, not a bonus.** Features 4 and 7 already need the vendor master and
> verified bank accounts, so a thin version (list, status, hold, bank-change request + verify)
> costs little once those exist. Agree an owner at kickoff.

## The six roles

Full permission matrix and the separation-of-duties rules:
[`architecture/roles-and-permissions.md`](architecture/roles-and-permissions.md).

| Role | Their home screen shows |
|---|---|
| Employee | My bills: the bills I requested and where each one is (read-only — suppliers send bills to AP, and the AP Clerk records me as the requester) |
| AP Clerk | Inbox triage, review queue with flags, coding, prepare payments |
| Approver | My approval queue (incl. as delegate), department spend |
| Finance Manager | Escalated and flagged approvals, vendor changes to verify, payments to release (≤ $100k CAD) |
| Controller / Admin | Users, roles, approval policies, any release, full audit log |
| Auditor | Read-only everything, audit export |

**Demo login:** a role switcher listing seeded users, so judges reach each role in one click.
It still sets a real server session — the server never trusts a role sent by the browser.

## The mess the data contains (each needs a flag or a path)

Duplicates and near-duplicates · price above contract · wrong tax for the province · changed bank
details · invoices split to stay under a limit · unknown or unapproved vendors · USD invoices ·
credit notes · odd dates · PO problems · requesters approving their own invoice · arithmetic
errors · low-quality scans · lookalike sender domains · non-invoice emails · emails with no attachment.

## Out of scope until 1–9 work

Bonus features (reconciliation, journal export, virtual card pay, early-pay discounts, AI
approval recommendation, plain-language spend questions, analytics, Slack/email approve,
bank-change alerts). Candidates once the core works: **bank-change / lookalike alerts** (reuses
feature 9 + intake) or **plain-language spend questions** (reuses the coded history).

## Demo script (keep it runnable at all times)

1. Clerk: inbox → a French scanned invoice becomes a draft with extracted fields.
2. Clerk: coding suggestion with its reason; a price-above-contract flag; a duplicate flag
   pointing at the card transaction.
3. Employee tries to approve their own invoice via the API → 403, escalated to their manager.
4. Approver on leave → delegate approves; audit shows *Delegate X on behalf of Y*.
5. Finance Manager who approved tries to release → refused; Controller releases.
6. Auditor opens the payment → PDF, extraction, coding, approval chain, release, all timestamped.
