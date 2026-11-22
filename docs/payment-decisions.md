# Payments — decisions (Katie)

**Last updated — payment session (branch `Katie`):** 2026-11-22 (Merging main into Katie)
**Last updated — dashboard session (branch `dashboard`):** 2026-11-21 (moved in from dashboard-todo.md by the payment session, one-time exception)

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
  were scheduled by AP clerks and released by someone else. The database has the same rule
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

- **Every piece we need from another feature sits behind one small adapter.** The adapters started
  with fake data; since 2026-11-21 they read the database (see "Payments on the database" below).
  *Why:* we didn't have to wait for anyone, and the payment rules never touch fake data directly.
  So swapping in the real thing didn't change the rules or their tests.
- Every assumption is written down in `payment-assumptions.md`, with its shape and owner.

### Decided by default while building (2026-11-21) — Katie to review

Katie said "stop asking and build everything", so these used the recommended option. Change any of them
and the code follows.

- **Sample data:** the database seed loads the real dataset CSVs (`npm run db:reset`), with no hand-written
  records. Payments shows only open work: the approved invoices and the scheduled EFT payments, plus anything
  paid through the app. The 10 months of paid history are not shown. Failed and on-hold payments only appear
  when you run the demo.
- **Cheque and card payments in the dataset are left out** (5 scheduled invoices: AP-00398, AP-00405,
  AP-00408, AP-00411, AP-00420), because payments does EFT only for now.
- **The dataset's unverified bank change (BC-009, Cascadia Cartage, by email) is a pending bank account.**
  Release to that supplier is refused until a Finance Manager or Controller verifies or rejects it.
  *Why:* it's the classic "we changed banks" email. Nobody should pay until a second person has checked.
- **Who approved:** Youssef's `approversOf()` over the approval plans in the database (the seed loads the
  dataset's approval history into them).
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
  saying no. (The "Reset demo data" button was removed on 2026-11-21: see "Payments on the database".)
- **Signed-in person:** the same cookie as the dashboard's "Viewing as" switcher (`hl_viewing_as`).
  The payment functions take the person's id as an argument (read from the session by the caller), so
  they can be tested.
- **Wording I wrote:** every refusal message in `rules.ts`, and three "next step" texts (account
  closed, account frozen, fraud hold).

### Dashboard connected to the real payments code (decided 2026-11-21)

- **One place for buttons.** Schedule, Release, Retry / Schedule again, Clear flag, Cancel and the bank change
  (enter, verify, reject) sit on the dashboard pages. `/payments-console` keeps only the demo
  control "Simulated bank" (the bank's answer for a released payment), linked from the dashboard header. *Why:* one screen per role, and an action taken anywhere shows up everywhere,
  because every page reads the same payments code.
- **No copies of rules or data on the dashboard.** The dashboard's copied types, sample data, failure
  reasons and release rules are deleted. It shows the server's own release check (every reason), the
  server's list of who can release, and the server's clear-flag rule. *Why:* two copies of a rule drift
  apart, and a judge will find the one that's wrong.
- **Defaults while building (Katie to review):** Cancel and the bank change are on the payment's detail
  page (they need a typed reason or numbers). The Finance Manager still doesn't see a Schedule button,
  which keeps the dashboard's rule. The audit trail on the detail page is the real payments audit log.
  The header's "Sample data" badge became the "Simulated bank (demo)" link.
- **A cancelled payment shows "Schedule again", a failed one shows "Retry"** (decided 2026-11-21).
  Both make a new attempt that goes through every check. After "Schedule again" the confirmation reads
  "Payment scheduled again (new attempt)". *Why:* a cancelled payment didn't fail, so "Retry" would make
  a judge read it as a failure.

### Payments on the database (decided 2026-11-21)

- **Payments reads and writes the team's Postgres database, not a copy in memory.** Users, suppliers,
  invoices, bank-account versions, release policies, approvals, payments, payment flags and the audit log
  all come from the tables the seed fills. *Why:* the in-memory copy reset on every restart, and a payment
  has to point at a real invoice row, so moving only half wouldn't work. The upload page's store stays in memory.
- **Payments uses the team's shared core.** Invoice status changes go through `fire()`, audit rows through
  `withAction()`, and every action calls `authorize()` first (`payment.prepare`, `payment.release`, and the
  bank-change actions). Payments' own checks still run and still list every reason. *Why:* hard rules 1–3.
  One state machine, one audit writer and one role table, which a judge can test by calling the server as
  the wrong role. The change and its audit rows commit together or not at all.
- **Why a bank account was closed comes from the payment flag that the failure raised.** No new column.
  *Why:* no schema change in a teammate's area. Every failure raises a flag, so every closed account has one.
- **The dashboard lists open work:** approved invoices and their payment attempts, plus anything paid through
  the app. Invoices that were already paid in the dataset's history aren't shown. *Why:* the same screen as before.
- **New payment IDs continue the dataset's numbering:** PAY-00416, PAY-00417, … *Why:* the ID is shown on the
  details page, and new payments should look like the old ones.
- **The audit trail on a payment's page shows payment events,** meaning payments, payment flags, bank accounts
  and the invoice's payment status changes, including the history the seed rebuilt (for example, who
  scheduled each dataset payment; those times are approximate). *Why:* it answers "what happened to this
  payment". Approvals and validation stay in the auditor's view.
- **An invoice with no due date is due on its invoice date plus the supplier's payment terms** (vendor
  master); if either is missing, today. That date is shown as its due date. *Why:* invoices from email can
  arrive without a due date, and that's how AP works one out.
- **"Reset demo data" button removed.** Reset with `npm run db:reset` in the terminal: it wipes and reseeds
  the local database, audit log included. *Why:* the database refuses to change or delete audit rows, so the
  app can't undo what happened. That's the point of an audit trail.
- **The payment session added the `await`s on the dashboard pages** for the three payment functions that now
  wait for the database (`canClearFlag`, `getPaymentAudit`, `getSupplierBank`). One-time exception, nothing else
  on those pages changed. *Why:* without them the build breaks.
- **`await connection()` before the payments pages read the database** (decided 2026-11-21): one line each in the
  dashboard's `_lib/data.ts` and `Sidebar.tsx` and in the simulated-bank page. *Why:* with the built-in database
  (`npm run demo`) Next.js logged an error on every payments page, shown in the red error overlay in dev. Checked in the
  real app: 8 pages, 0 errors.
- **Tests run on the seeded in-process database (PGlite)**, with the same scenarios and the same expected results.
  The in-memory `fake-data/` folder is deleted.

### Merging main's one dashboard into Katie (decided 2026-11-22)

- **Main's deletions of `app/payments-console/page.tsx` and `app/payments/_components/Sidebar.tsx` are
  accepted.** *Why:* main's one dashboard for five roles (`98e3f87`) replaced those screens. Editing files
  main no longer has would leave dead code.
- **`viewerId()` in `app/payments/_lib/data.ts` keeps `await connection()`, then main's `await ensureDb()`.**
  *Why:* main's `data.ts` didn't have the request-time fix, and without it Next.js logs a prerender error on
  every payments page.

## Dashboard decisions

_(Moved here from `docs/dashboard-todo.md` on 2026-11-21, a one-time exception by the payment session.)_

### Sign-in and page layout (decided 2026-11-21)

- **No login page. A "Viewing as: name (role)" switcher sits top-right on every page.** It picks a
  person from the dataset and stores only their id in a cookie. The role is always looked up on the
  server from the employee record (`getCurrentUser()` in `src/server/session/`, TEMP, so the payment
  session can import it directly). This replaces the earlier "one view, role filter nice-to-have" and the
  "Sign in as… page" idea; the role filter is dropped. *Why:* separation of duties depends on who approved
  or scheduled, so the demo must switch people, not roles.
- **The menu is grouped by type** (Controller, Finance Manager, Clerk, Other employee) **and you pick a
  person within the type.** *Why:* the type gives the options; the person decides which payments you're
  blocked from (you can't release what you approved).
- **Nobody picked means view only**, and the switcher says "Choose who you are". *Why:* no identity means
  no actions.
- **Pages with a sidebar:** Overview, To schedule (Clerk), Release queue (Finance Manager up to $100k CAD,
  larger ones show "Needs Controller"; the Controller sees all plus escalations), Needs attention (failed
  and on hold), and Details per payment (attempt history, audit trail, blocked reasons). *Why:* each role
  gets its own screen (UI is 20% of the score), and switching people visibly changes the app.
- **The sidebar shows only the current role's pages, and each page checks the same list on the
  server.** "Other employee" is read-only with no actions. *Why:* each role sees only what it can act on,
  and hiding a link isn't security.
- **Auditor sees every page, read-only;** other employees see Overview and Details only. *Why:*
  product.md gives the Auditor "read-only everything".
- **Details page URL is the invoice ID** (`/payments/AP-00401`). *Why:* one page shows every attempt, and
  a retry gets a new payment ID.
- **Action buttons come from the payment session.** The dashboard first had TEMP "Actions" spots; since
  2026-11-21 they hold the real buttons (see "Dashboard connected to the real payments code" above).

### Flags display (decided 2026-11-21)

- **Where:** tables show the top open flag; Needs attention is sorted critical first; Details shows all
  flags, with cleared ones greyed and who cleared them, when, and the note.
- **Counts** of open flags, "1 critical · 3 high · 0 low", on Needs attention and the Overview card.
- **Colours** per payment-data.md: critical red, high amber, low grey. Labels "Critical / High / Low",
  "Clear flag".
- **"Clear flag" only for the people the clear rule allows.** At first a TEMP copy of the payment
  session's rule; since 2026-11-21 the server's own rule.
- *Why:* Katie's spec in payment-data.md plus the recommended defaults.

### Upload screen (decided 2026-11-21)

- Built by the dashboard session. Page "Upload invoices" at `/payments/upload`, for AP Clerk and
  Controller only.
- PDF/PNG/JPG up to 4 MB, several at once, read one at a time; the original sits beside the form.
- Fields: vendor, invoice number, invoice and due date, currency, PO number, ship-to province, line items,
  taxes, subtotal, total. Unsure fields (confidence < 0.8) are marked "Check this"; every field is editable.
- Required: vendor, invoice number, invoice date, currency, total, requester and department. The uploader
  picks the requester and department.
- Confirm saves the invoice as In review (TEMP memory store, IDs UP-0001…) in Andrew's ValidationInput
  shape, then shows "Saved. {Vendor} invoice {number} is now in review." and opens the next file.
- Until extraction exists, every file is manual entry.
- *Why:* the recommended defaults Katie approved with "go".
- **Open:** how judges hand over the hidden invoices (ask the organizers).

### Look and feel (decided 2026-11-21)

- **Brim-inspired look, feel only, no Brim logo or artwork.** This replaces "minimal, like Stripe or Ramp"
  and the earlier navy/teal/cyan hexes. Blue frame (top bar and sidebar, ~#2E5A76) and turquoise accent
  (~#54B8D0), eyeballed from a brimfinancial.com screenshot; light grey content (#F5F7FA) with white cards;
  a bold rounded display font (Nunito, via next/font) for page titles and summary numbers; plain-text
  "Brim AP" title top-left. Status badges keep their meaning colours (settled green, failed red, on hold
  amber, scheduled blue, released purple, cancelled grey). *Why:* UI is 20% of the score and Brim staff
  judge; status colours carry meaning.
- **Colour details:** keep the eyeballed blue (#2E5A76) and turquoise (#54B8D0); exact brand values don't
  matter much. Links and focus rings on white use a deeper turquoise (#1E7A90); buttons, the active page
  marker and focus rings on the blue frame use the bright turquoise. *Why:* bright turquoise on white is
  too faint to read (2.3:1); the deeper shade is 4.9:1.
- **Colour tokens stay in `app/payments/brim-theme.css`** (dashboard-owned) for now. *Why:* no shared file
  touched, no merge conflicts. **Open for the team:** move them into a `@theme` block in `app/globals.css`
  so everyone gets classes like `bg-brim-frame`.
- **Brief check:** `docs/brief.md` has no branding rules (no logo, colour or name rules); the team docs
  have none either.

## Likely judge questions

- **"What happens if a payment comes back as fraud?"** Every payment to that supplier stops,
  including new ones. Only the Controller can clear it, with a written reason, and never the person
  who scheduled the payment. Smaller problems get smaller reactions: a closed account flags the
  supplier's other payments for review, and a bank glitch only flags that one payment. The level
  comes from a lookup table, so changing it is one line.

## Payment log

| Date | Topic | Decision | By |
|---|---|---|---|
| 2026-11-22 | Merging main into Katie | Accept main's deletion of `payments-console/page.tsx` and `Sidebar.tsx`; `data.ts` keeps `connection()` before `ensureDb()` | Katie |
| 2026-11-21 | `await connection()` | Payments pages read the database at request time; no Next.js prerender errors with `npm run demo` | Katie |
| 2026-11-21 | Payments on the database | Postgres through the shared core (`fire`, `withAction`, `authorize`); open work only; closed reason from the flag; dashboard `await`s; tests on PGlite; `fake-data/` deleted | Katie |
| 2026-11-21 | Reset demo data | Button removed; reset with `npm run db:reset` (audit rows can't be deleted) | Katie |
| 2026-11-21 | New payment IDs | Continue the dataset's numbering: PAY-00416, … | Katie |
| 2026-11-21 | Payment audit trail | Payment events, including the seed's rebuilt history | Katie |
| 2026-11-21 | No due date | Invoice date + the supplier's payment terms; otherwise today | Katie |
| 2026-11-21 | Wrap-up docs | STATUS section, TODO moved to completed (Katie), duplicate pair as a Duplicates TODO, BUG-Katie-01/02 + 2 backend rules, `7-payments.md` | Katie |
| 2026-11-21 | Schedule again confirmation | After "Schedule again" the message reads "Payment scheduled again (new attempt)" | Katie |
| 2026-11-21 | Cancelled payment button | "Schedule again" instead of "Retry"; failed payments keep "Retry" | Katie |
| 2026-11-21 | Dashboard on real data | Dashboard reads and acts through the payments code; copies deleted; console keeps only the simulated bank + reset | Katie |
| 2026-11-21 | STATUS Payments owner | "Katie (building), Youssef (listed on main), to confirm" | Katie |
| 2026-11-21 | Connected to approvals | Who approved and the approved payee/amount now come from Youssef's store; a payments seed loads the dataset history until his flow fills it | Katie |
| 2026-11-21 | Merged main + dashboard | main's tooling kept, Next on tsconfig.next.json; strict index checks fixed in our files | Katie |
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
| 2026-11-21 | Upload screen | Drop zone + check-and-confirm page for Clerk/Controller; manual entry until extraction exists; saves In review | Katie |
| 2026-11-21 | Flags display | Critical/High/Low badges, open counts, most urgent first, Clear flag per payment rule | Katie |
| 2026-11-21 | Colour details | Keep eyeballed blue/turquoise; deeper turquoise for links and focus rings on white; tokens stay in the dashboard's theme file | Katie |
| 2026-11-21 | UI style | Brim-inspired blue/turquoise theme, one tokens file; status colours unchanged | Katie |
| 2026-11-21 | Switcher details | Grouped by type, pick a person; nobody = view only; Auditor sees all read-only; details URL = invoice ID | Katie |
| 2026-11-21 | Sign-in and page layout | Switcher instead of login page; split into role-specific pages with a sidebar | Katie |
