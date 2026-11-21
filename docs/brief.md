# Brim Hackathon Brief: AP Automation for Business Cards

## 1. Context

You and your team will build an accounts payable (AP) automation for a business card platform.

Small and mid-sized businesses spend on the card but pay supplier invoices outside the platform, in email threads, spreadsheets and the accounting system. AP automation closes that gap: invoices arrive, get read and coded, get approved by the right people, and get paid from the same platform that issues the card.

**Your role.** You are the product and engineering team for this feature. Deliver a working web application that takes a supplier invoice from inbox to payment, with the right people approving each step and a full audit trail afterward.

**The customer you are building for.** Harborline Logistics Inc. (fictional) is a 40-person Canadian logistics company with offices in Toronto, Vancouver, Calgary and Montréal. Its finance team works with about 50 suppliers and processes around 50 invoices a month.

**Canadian context.** Invoices carry GST/HST or provincial taxes (PST/QST), amounts are mostly CAD with some USD, suppliers are paid by EFT, and records need to be audit-ready for the CRA.

**FYI**
- All data is synthetic. No real payments move; payment execution is simulated.
- Use any language, framework or AI tooling you like, including LLMs for extraction and coding.
- Your team must be able to explain every design decision, including the ones an AI wrote.

## 2. Sample data

Each team receives a synthetic dataset for Harborline Logistics covering ten months of AP history (January to October 2026) plus a fresh batch of unprocessed invoices to run through your system. Nothing in it is real: names, tax numbers and bank details are fictional.

Expect real-world mess. The incoming batch and the history include duplicate and near-duplicate invoices, prices above contract, tax charged incorrectly, changed bank details, invoices split to stay under an approval limit, unknown or unapproved vendors, USD invoices, credit notes, odd dates, PO problems, requesters who cannot approve their own invoices, arithmetic errors, and low-quality scans. Finding these is part of the job.

## 3. Standard feature set: focus on a few and implement them well

### Role-based feature control

Every user in the sample data has one of six roles. What each person sees and can do must change with their role, and the rules must be enforced on the server, not only hidden in the interface.

Two rules apply to every role. Nobody approves an invoice they requested; it escalates to their manager instead. Anyone who approves an invoice cannot release its payment. Actions taken by a delegate must be recorded as such.

### Standard features

The 9 required features (worth 40% of the score, tested on a hidden batch of invoices):

1. **Intake**: pick up invoices from the AP inbox and uploads; recognise emails that aren't bills.
2. **Extraction**: read PDFs and scans (including French and low-quality ones) into structured fields.
3. **Categorization (coding)**: suggest GL account and department, with a reason based on history.
4. **Validation checks**: vendor master, PO, contract prices, tax for the place of supply, arithmetic, FX.
5. **Duplicate checks**: exact and near-duplicate invoices, including ones already paid by card.
6. **Approval routing**: send each invoice to the right approvers per the policies, with escalation and delegation.
7. **Payment**: simulated release of approved invoices (EFT / cheque / card), respecting separation of duties.
8. **Audit trail**: who did what and when, from the original document to payment.
9. **Dashboard**: a role-specific view of the queue and flags for each user.

<!-- Feature names are from the official brief; the one-line descriptions are our summary. Replace with the brief's own wording if you have it. -->

### Bonus features

Bonus features are scored only if the required features work. Ideas, with no limit on others:

- Reconcile payments to the bank statement and explain unmatched items.
- Export approved invoices and payments as a journal for an accounting system.
- Pay a supplier with a single-use Brim virtual card where the vendor accepts cards.
- Capture early-payment discounts, and suggest the best day to pay each invoice.
- Recommend an approval decision with a reason, and flag items that need a closer look.
- Ask questions about spend in plain language, such as "what did Operations spend on freight last quarter?"
- Show spend analytics by vendor, department and category.
- Approve from a phone, or from Slack or email.
- Alert on suspicious changes to vendor bank details or lookalike senders.
- Anything else you think an AP team would pay for. Tell us why it matters.

## 4. How you will be judged

Judges score four things, and working software counts for the most. Required features are tested on a hidden batch of invoices your team has not seen.

Technical depth is judged in a live Q&A, so using AI to write code is fine, but you must be able to explain and defend it. A polished demo that the team cannot explain will score lower than a simpler one it fully understands.
