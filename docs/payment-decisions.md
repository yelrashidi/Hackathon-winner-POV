# Payments — decisions (Katie)

**Last updated — payment session (branch `Katie`):** 2026-11-21 (steps 1–8 built)
**Last updated — dashboard session (branch `dashboard`):** —

What we decided for payments and the payments dashboard, and **why**, in sentences you can say
out loud to a judge. Likely judge questions are near the bottom.

## How to update this file

- **Two sessions edit this file. Each one edits only its own parts**, so the branches never touch
  the same lines and merge cleanly:
  - **Payment session (branch `Katie`):** the pitch, "Payment decisions", "Likely judge questions",
    its own "Last updated" line, and the **Payment log**.
  - **Dashboard session (branch `dashboard`):** "Dashboard decisions", its own "Last updated" line,
    and the **Dashboard log**.
- **Each decision** gives the question, the decision, and *why*.
- **A new decision that replaces an old one:** edit the old entry. Never leave two conflicting answers.
- **Every change** adds one line to your own log, newest first: `| Date | Topic | Decision | By |`.
- Update your own "Last updated" line.

## The one-sentence pitch

Once an invoice is approved, an AP clerk schedules the payment, a *different* person with enough
authority releases it to the vendor's *verified* bank account, and a simulated bank settles or
fails it. Every step is checked on the server and written to the audit trail.

## Payment decisions

### Failed payments (decided 2026-11-21)

- **A failed payment is not a paid invoice.** We still owe the supplier, so the invoice goes back
  to "needs payment" with a "needs attention" flag. *Why:* the worst AP mistake is marking a bill
  paid when the money never arrived. The supplier then chases us, or cuts us off.
- **Every try is its own attempt, and failed attempts are never overwritten.** Only one attempt per
  invoice can be active at a time. *Why:* an auditor can see exactly what happened ("Attempt 1
  failed, account closed. Attempt 2 settled."). And because only one attempt can be live, we can't pay twice.
- **No automatic retries. A person clicks Retry, and the new attempt goes through every check
  again.** *Why:* a lot can change between attempts. The bank details might have changed, or a
  duplicate might have been found. An automatic retry would skip those checks, and the checks are the whole point.
- **Every failure has a reason code, a plain message and a next step.** One lookup table gives each
  reason two things: what happens to *its own retry*, and its *urgency*, meaning what happens to the
  supplier's other payments (see "Urgency flags" below).
  - *Retry allowed:* bank error, or insufficient funds on our side.
  - *Fix bank details first:* account closed, invalid account, invalid branch, name mismatch,
    currency not supported, account frozen.
  - *Controller clears first, then retry:* fraud hold. The retry goes through every check again.

  *Why:* the person looking at the failure shouldn't have to guess what to do. Adding a new bank
  reason takes one line in the table.
- **A bank-detail failure marks that bank account as not payable.** Every other payment to it is then
  blocked by the normal "verified bank account only" rule, and its High flag explains why.
  *Why:* if the account is closed for one payment, it's closed for all of them. We don't send more
  money to an account we know is dead.
- **New bank details are "changed, not verified" until a different person verifies them, and release
  is blocked until then.** *Why:* "we changed banks, pay this new account" is the classic invoice
  fraud. Two people, both in the audit trail, means one person alone can't redirect money.

### Urgency flags (decided 2026-11-21, replaces the earlier stop/flag ideas)

Each failure reason maps to an urgency level in one lookup table, so it's easy to change.

- **Critical: fraud hold.** All of the supplier's payments stop: scheduled ones go `on_hold`, and new
  ones can still be scheduled but start `on_hold`. Release refuses with *"Stopped: fraud hold on this
  supplier. Controller must review."* Only the Controller role (the Controller or the CFO) can clear it,
  with a required note, and never the person who scheduled the payment. When it's cleared, held
  payments go back to "scheduled" automatically and still need a normal release.
- **High: account frozen, account closed, invalid account, invalid branch, name mismatch, currency not
  supported.** The supplier's other payments get a review flag: *"Review: a payment to this supplier
  failed (Account closed) on 2026-11-21."* The flag itself doesn't block release. The failed bank account
  being unpayable does, as above. It clears automatically once new bank details are verified, or anyone
  in finance (AP clerk, Finance Manager, Controller) can clear it with a one-line note.
- **Low: bank error, insufficient funds.** The flag sits only on the failed payment, not the supplier,
  because it isn't the supplier's fault: *"Last attempt failed: Bank error. Retry when ready."* It clears
  automatically when the retry is scheduled, or anyone in finance can clear it. No note needed.
- **For every level:** view-only people (employees, approvers, the auditor) can't clear flags. Every
  flag created and every flag cleared goes in the audit trail with who, when and the note. All
  clearing rules are checked on the server, not just by hiding buttons.
- **Payments keep their own flag list**, separate from the shared invoice flags, because a Critical
  flag belongs to a supplier, not to one invoice.

*Why:* not every failure is equally scary. A bank glitch shouldn't freeze a supplier, but a fraud
hold should stop every payment to them until a senior person has looked. Matching the reaction to
the risk keeps payments moving without letting fraud through.

### Using Youssef's approvals code (decided 2026-11-21)

- **We don't re-implement "who approved this?" We call approvals' own `approversOf()`.**
  *Why:* the rule "an approver can't release the payment" depends on knowing exactly who signed,
  including a delegate *and* the person they signed for. If approvals and payments each worked
  that out separately, the two answers could drift apart. One function answers it once.
- **We check every approval round the invoice ever had, not just the latest.** *Why:* if
  someone approved version 1 and the invoice was then edited and re-approved by someone else,
  the first approver was still involved. They shouldn't be the one who releases the money.
- **Bank accounts record which currency they accept (CAD or USD).** *Why:* sending US dollars to
  a Canadian-dollar-only account bounces. We'd rather refuse before release than find out
  from the bank. The dataset doesn't have this field, so existing accounts default to CAD. Every
  vendor with bank details in the data is Canadian, and the US vendors are paid by card.

### Interview decisions (2026-11-21)

- **Q1 Partial payments: no. Every payment is for the full invoice amount.** *Why:* paying an
  invoice in pieces is a classic way to get under the $100k release limit: four $30k payments
  instead of one $120k one. A disputed line goes back to review (edit or credit note); it doesn't get
  a smaller payment. Each payment still shows its amount, and it always equals the invoice total.
- **Pay only what was approved.** Release is refused if the payment would go to a different
  vendor than the one approved, or for more than the approved amount. *Why:* approvers sign off
  on a specific payee and amount. If either changes after approval, nobody approved what's actually
  being paid, so it has to go back through approval.
- **Q2 Payment timing: the clerk picks a pay date, defaulting to the invoice due date. Release
  sends the payment immediately.** The release queue is sorted by pay date, so the most urgent is
  on top, and the dashboard shows "due in 3 days" or "overdue". *Why:* clerks plan around due
  dates, which keeps cash in the company until it's needed without paying late. In production the
  bank file would go out on the pay date. In this simulation, release sends it right away, so the
  demo doesn't need a fake clock.
- **Q3 Weekends: a default pay date that falls on a Saturday or Sunday moves back to the Friday
  before.** If the clerk picks a weekend date themselves, they get a warning. *Why:* banks don't
  run EFT on weekends, so a Saturday payment arrives Monday, which is late. Moving it earlier means
  we're never late because of a weekend. **Known gap:** statutory holidays (Canada Day, and
  provincial ones like St-Jean-Baptiste) aren't handled. They'd come from a bank-calendar table,
  and the dataset doesn't include one.
- **Q4 Cancel: a scheduled payment can be cancelled until it's released, with a required reason.**
  The AP clerk, Finance Manager or Controller can cancel it. The cancelled payment stays in the
  history, and the invoice goes back to "Approved". *Why:* things change between scheduling and
  release. The supplier says the invoice was wrong, a duplicate turns up, or the bank account
  closed. After release the money has left the company, and EFT can't be reliably recalled, so
  the only outcomes are the bank's: settled or failed. That's why release is the step with all the checks.
- **Q5 Whoever scheduled a payment can never release it, whatever their role.** *Why:* this is the
  "four eyes" rule. Setting up a payment and sending it are two separate keys, so no one person can
  move money out alone. It costs nothing in practice: in ten months of history, all 415 payments
  were scheduled by AP clerks and released by someone else. The planned database has the same rule
  (`released_by` ≠ `prepared_by`) as a backstop.
- **Q6 Whoever requested an invoice can never release its payment.** *Why:* it's the same idea as
  "you can't approve your own request". Nobody should be able to buy something and also send the money
  for it. In the data, requesters are employees and clerks, who can't release anyway, so this
  only matters when a manager buys something for themselves. That's exactly the case to stop.
- **Q7 Only people who are active today can schedule or release.** Someone on leave or who has left
  the company can't. *Why:* it matches approvals: who may act is decided from today's staff list,
  not from who was assigned earlier. **No delegation for release:** release isn't one person's job.
  Three people can release (the Finance Manager, the Controller and the CFO), so when one is away,
  the others do it, and the screen shows who can. *Why:* handing release powers to a delegate is how
  money-sending authority ends up with someone who shouldn't have it. And it adds no coverage,
  because someone else eligible is always there.
- **Q9 Changes between scheduling and release: release re-checks everything at that moment.** That
  means the bank account, open flags such as duplicates, the approval, and the people involved. Any
  problem shows as a red reason and blocks the release. Other features don't put payments on hold
  automatically. *Why:* the moment money leaves is the moment that has to be right, and checking in
  one place means we don't depend on hooks in teammates' code that don't exist yet.
- **Q10 Who sees payment data: it follows the team's role table, and bank account numbers show only
  their last 4 digits, everywhere.** Employees see payment status for their own invoices,
  approvers for their department, and the AP clerk, Finance Manager and Controller see everything.
  The Auditor sees everything but can't change anything. *Why:* least access. Bank numbers are
  exactly what a fraudster wants, and nobody needs the full number on screen. The fake bank gets it
  on the server; the browser never does.

### Building before teammates finish (decided 2026-11-21)

- **Every piece we need from another feature sits behind one small adapter.** Today the adapters
  return fake data. At the end, we swap each one for the teammate's real code.
  *Why:* we didn't have to wait for anyone, and the payment rules never touch fake data directly.
  So swapping in the real thing doesn't change the rules or their tests.
- Every assumption is written down in `payment-assumptions.md`, with its shape and owner.

### Decided by default while building (2026-11-21) — Katie to review

Katie said "stop asking and build everything", so these used the recommended option. Change any of them
and the code follows.

- **Sample data:** the real dataset CSVs are loaded at startup, with no hand-written records. Only open work
  is loaded: 2 approved invoices and the scheduled EFT payments. The 10 months of paid history are not.
  Failed and on-hold payments only appear when you run the demo.
- **Cheque and card payments in the dataset are left out** (5 scheduled invoices: AP-00398, AP-00405,
  AP-00408, AP-00411, AP-00420), because payments does EFT only for now.
- **The dataset's unverified bank change (BC-009, Cascadia Cartage, by email) is a pending bank account.**
  Release to that supplier is refused until a Finance Manager or Controller verifies or rejects it.
  *Why:* it's the classic "we changed banks" email. Nobody should pay until a second person has checked.
- **Who approved:** read from the dataset's approval history for now. It swaps to Youssef's
  `approversOf()` at step 11.
- **Pay date:** an overdue invoice defaults to today. A weekend date moves to the Friday before, or to
  the next Monday if that Friday has already passed. A pay date in the past is refused.
- **A failed bank account gets the status `closed`**, so it can't be paid until new details are verified.
- **Release also refuses:** non-EFT payments, a CAD amount that doesn't equal total × rate (±1¢, from
  Youssef's BUG-Youssef-02), and suppliers that aren't active.
- **Bank changes:** an AP Clerk, Finance Manager or Controller enters them. A Finance Manager or Controller
  verifies or rejects them, and never the person who entered them. Only one pending change at a time.
  Numbers are checked as 3 / 5 / 7–12 digits.
- **"Simulate bank answer"** can be pressed by any finance role (it's a demo control).
- **UI:** the buttons live on their own page, `/payments-console`, so payments doesn't touch the
  dashboard's `/payments` pages. Release stays clickable even when refused, so you can show the server
  saying no. There's also a "Reset demo data" button.
- **Signed-in person:** the same cookie as the dashboard's "Viewing as" switcher (`hl_viewing_as`).
  The payment functions take the person's id as an argument (read from the session by the caller), so
  they can be tested.
- **Wording I wrote:** every refusal message in `rules.ts`, and three "next step" texts (account
  closed, account frozen, fraud hold).

## Dashboard decisions

_(filled in by the dashboard session)_

## Likely judge questions

- **"What happens if a payment comes back as fraud?"** Every payment to that supplier stops,
  including new ones. Only the Controller can clear it, with a written reason, and never the person
  who scheduled the payment. Smaller problems get smaller reactions: a closed account flags the
  supplier's other payments for review, and a bank glitch only flags that one payment. The level
  comes from a lookup table, so changing it is one line.

## Payment log

| Date | Topic | Decision | By |
|---|---|---|---|
| 2026-11-21 | Built steps 2–8 (defaults) | See "Decided by default while building": dataset CSVs, EFT only, BC-009 pending blocks release, `closed` bank status, `/payments-console`, shared session cookie | Katie |
| 2026-11-21 | Payment data shape (step 1) | Statuses + moves as in payment-data.md; invoice names Approved/PaymentScheduled/Paid; dashboard's record shapes kept plus bankAccount, cancelledBy/At, failure, flags, releaseCheck; read via listPayments()/getPaymentDetail() | Katie |
| 2026-11-21 | Bank change and verify | Payments builds the minimum (enter new details, second person verifies), marked TEMP: vendors | Katie |
| 2026-11-21 | Urgency flags | Critical (fraud hold) stops the supplier; High flags its other payments; Low only the failed one; own flag list; clearing rules and audit | Katie |
| 2026-11-21 | Failed bank account | Marked not payable, so other payments to it are blocked by the verified-bank rule | Katie |
| 2026-11-21 | Failure retry rules | Account frozen moves to "fix bank details"; fraud hold can be retried after the Controller clears it | Katie |
| 2026-11-21 | Who sees payment data | Role table; bank numbers show last 4 digits only | Katie |
| 2026-11-21 | Changes after scheduling | Release re-checks everything at that moment; no automatic holds from other features | Katie |
| 2026-11-21 | Decisions file | `payment-notes.md` renamed to `payment-decisions.md`; one "Last updated" line and one log per session | Katie |
| 2026-11-21 | Staff on leave or gone | Only people active today can schedule or release; no delegation for release, other eligible people release | Katie |
| 2026-11-21 | Requester can't release | Whoever requested an invoice can never release its payment | Katie |
| 2026-11-21 | Scheduler can't release | Whoever scheduled a payment can never release it | Katie |
| 2026-11-21 | Cancel | Only before release, with a reason; invoice goes back to Approved | Katie |
| 2026-11-21 | Weekends | Default pay date on a weekend moves to the Friday before; holidays are a known gap | Katie |
| 2026-11-21 | Payment timing | Pay date defaults to the due date; release sends immediately | Katie |
| 2026-11-21 | Pay only what was approved | Release refused for a different payee or a higher amount than approved | Katie |
| 2026-11-21 | Partial payments | No; every payment is the full invoice amount | Katie |
| 2026-11-21 | Bank account currency | Bank accounts record CAD or USD; existing ones default to CAD | Katie |
| 2026-11-21 | Who approved | Use approvals' `approversOf()` over every approval round | Katie |
| 2026-11-21 | Building ahead of teammates | Each dependency behind one adapter; assumptions in `payment-assumptions.md` | Katie |
| 2026-11-21 | Failed payments | Separate attempts, no automatic retry, reasons grouped by next step, bank-detail holds, two-person bank verification | Katie |

## Dashboard log

| Date | Topic | Decision | By |
|---|---|---|---|
