# Demo run sheet — live email to payment

One supplier bill, live: **email → read → checked → approved → paid → proven.**
Everyone drives the part they built, so everyone can answer the judges' questions about it.

This is the **live-Gmail** version. The click-by-click path for a bill already in the dataset,
verified in a browser, is [`demo-script.md`](demo-script.md); fall back to it if email fails.

Total: about 10 minutes plus Q&A. Times are targets; rehearse once end to end.

---

## 1. Cast — the five people who can sign in

Only these five can sign in, and they are the only requesters the forms offer
(`src/server/session/roster.ts:8`). Switch with the **Viewing as** menu, top right.

| Person | Role | Job in the demo |
|---|---|---|
| Jordan Okafor | AP Clerk | Checks the bill, sets the requester (Jordan), schedules the payment |
| Dev Malhotra | Operations Manager | Approves (department manager) |
| Elise Tremblay | Finance Manager | Approves over $10k; releases up to $100k |
| Marcus Webb | Admin (Controller) | Approves over $50k; releases only what Elise can't |
| Hannah Lindqvist | Auditor | Read-only, sees everything |

Priya Raman (CFO) and the other employees stay in the database for routing and history but
cannot sign in.

## 2. Who presents what

| Presenter | Steps |
|---|---|
| Arpan | 1–2: email arrives, read, flagged; duplicate catch |
| Youssef | 3–4: clerk check screen, approval |
| Katie | 5–6: schedule, release, the refusals, bank answer |
| Andrew | 7: audit trail; validation questions |

---

## 3. Before the demo (checklist)

- [ ] `docker compose up -d` at least 10 minutes before. Confirm http://localhost:3000 loads.
- [ ] `docker compose logs -f gmail-poller` open in a terminal: it prints `No new mail.` every ~10 s.
- [ ] Gmail and Claude keys in `.env.local` (`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `ANTHROPIC_API_KEY`).
- [ ] On the sending phone, ready as attachments:
  - **Main bill:** `fixtures/demo/polar-freight-000975.pdf` — Polar Freight, $2,918.86 CAD, a supplier in the vendor master, not in the dataset yet.
  - **Duplicate:** `brim_ap_dataset/brim_ap_dataset/incoming_invoices/polarfreightline_000963.pdf` — the same file is already in the seeded data, so it should come back `DUPLICATE_INVOICE`.
  - **Junk:** one obvious non-bill (a "YOU WON A PRIZE" email with any non-invoice PDF).
- [ ] **Use a supplier from the vendor master.** A bill from an unknown supplier reaches Checks fine, but its release is refused (`VENDOR_UNKNOWN`) until someone onboards the vendor.
- [ ] Browser on the home page, signed out ("Who are you today?").
- [ ] **Rehearse steps 1–7 once with these exact files** (the duplicate catch has not been run live yet).

---

## 4. The run

### Step 1 — The email arrives (Arpan, ~1.5 min)

**Do:** email the Polar Freight 000975 PDF, live. Show the poller log.
**Expect:** within ~10–30 s (Claude reads the PDF) the log prints
`INVOICE … saved · … ingested → InReview, flags: …`.
**Say:** "We poll the inbox. Rules first, then an AI where it's fuzzy, decide what is a bill.
Spam, newsletters and receipts never become bills."
**Also:** send the junk email. The log shows `IGNORED`; nothing reaches the dashboard.

### Step 2 — It shows up flagged (Arpan, ~1 min)

**Do:** sign in as **Jordan Okafor**. Home → **Next checks**.
**Expect:** the bill, marked "from email", with its flag tags (red = blocking, amber = warning).
**Say:** "The AI only *reads* the document. Every check is plain code, and each flag has a code
and a message with the real numbers, so you can ask us why any flag fired."
**Duplicate moment:** email the 000963 PDF now; it lands tagged `DUPLICATE_INVOICE`.

### Step 3 — The clerk checks it (Youssef, ~2 min)

**Do (as Jordan):** open the bill. The original PDF sits beside the extracted fields.
1. Fix any wrong field.
2. **Requester** → *Jordan Okafor* → **Save changes**.
3. Coding card → **Accept high-confidence** lines.
4. Resolve or override any flags (a note is required).
5. **If you submit now** shows *Waiting on Dev Malhotra* → **Submit for approval**.

**Say:** "A person confirms every coded line. The queue puts first what the machine couldn't do."

### Step 4 — Approval (Youssef, ~1 min)

**Do:** Viewing as → **Dev Malhotra** → **Approvals** → open the bill → **Approve**.
**Say:** "Up to $10,000 the department manager alone approves (policy P01). Routing reads the
policies from the dataset; nothing is hardcoded."

### Step 5 — Schedule the payment (Katie, ~1 min)

**Do:** Viewing as → **Jordan** → **To schedule** → **Schedule**.
**Expect:** pay date defaults to the due date (moved to Friday if it falls on a weekend).
**Say:** "Scheduling prepares the payment: who, how much, which verified bank account, and when.
No money moves yet."

### Step 6 — Release, the refusals, the bank answer (Katie, ~1.5 min)

**Refusal first:** show that Jordan can't release (or call the release API as Jordan).
Clerks can't release (P09), and whoever scheduled a payment never releases it (`SCHEDULED_IT`).

**Release:** Viewing as → **Elise Tremblay** → **To release** → **Release**.
**Bank answer:** header **Demo controls** → **Send bank answer** (Settled). Now it is **Paid**
(payments are simulated).
**Say:** "Separation of duties lives on the server, not in hidden buttons. The API gives the
same answer as the screen."

### Step 7 — Proof (Andrew, ~1.5 min)

**Do:** Viewing as → **Hannah Lindqvist** → **Audit trail** → search the invoice number → open it.
**Expect:** the original email and file (with its sha256), what the AI read, every flag and who
closed it, Dev's approval, Jordan scheduling, Elise releasing, the exact bank account paid, and
the automatic control checks.
**Say:** "Every change writes an audit event in the same transaction. The app's database role
can't edit or backdate audit history."

---

## 5. The twist, if time allows: a bill between $10k and $50k (~1.5 min)

Approvers: Dev → **Elise**. Then, as **Elise**, try to release.

**Expect:** "Elise Tremblay approved this invoice, so they can't release its payment (policy
P11)." Switch to **Marcus Webb** (Admin): he may release it, because Elise can't.

This is the rule judges are most likely to test. **Pick the bill and rehearse it beforehand:** a
dataset invoice from a vendor in the master, total between $10k and $50k CAD.

## 6. Who approves and releases, by amount (under $100k)

| Bill total (CAD) | Approvers, in order | Releaser | In the demo? |
|---|---|---|---|
| ≤ $10,000 | Dev | Elise | Yes — the main run (P01, P09) |
| $10,000–$50,000 | Dev → Elise | Marcus | Yes — the twist (P02, P11) |
| $50,000–$100,000 | Dev → Elise → Marcus | Priya (CFO) | **No** — Elise and Marcus both approved, and Priya can't sign in. A talking point only. |

Other rules worth knowing for questions (talking points; the people involved are not in the
sign-in cast):

- **New or unreviewed supplier:** Elise is added as an approver at any amount (P05), so the release moves to Marcus.
- **Self-approval:** a manager's own request goes up to their manager (P07).
- **Manager on leave:** Liam O'Connor (Facilities) is on leave; his approvals go to his delegate, recorded as "on behalf of" (P08).
- **Over $100,000:** only the Admin/Controller releases (P10).

---

## 7. If something goes wrong

| Problem | Fix |
|---|---|
| Email doesn't appear after 60 s | Check the poller log. If it says `IGNORED`, show that as a feature ("not a bill") and upload the PDF at **Checks → Upload** instead (`demo-script.md`, steps U1–U5). |
| Poller container stopped | `docker compose up -d gmail-poller`. On its first run it reads back one day of inbox mail (`GMAIL_BACKFILL`). |
| Mail sent before the poller started is missing | `docker exec -w /app hackathon-winner-pov-gmail-poller-1 npx tsx scripts/gmail-poll.ts --backfill 1d` (safe to repeat: saving is idempotent). |
| Release refused with `VENDOR_UNKNOWN` | The bill came from a supplier not in the vendor master. Use the Polar Freight PDF. |
| Extraction is slow | Talk through Step 2's "rules vs AI" point while it runs. |
| Someone can't see a page | That's the role matrix working; switch to the right person. |
| Everything is broken | Run [`demo-script.md`](demo-script.md) on the seeded bill 000963. |

## 8. Q&A prep — where the answers live

| Question | Source |
|---|---|
| Why can't the scheduler release? | `src/server/features/payments/rules.ts:156` (`SCHEDULED_IT`) |
| Why can't an approver release? | `src/server/features/payments/rules.ts:153` (`APPROVED_IT`, policy P11) |
| Finance Manager release limit? | `src/server/features/payments/rules.ts:144` (`OVER_RELEASE_LIMIT`, from the policies CSV) |
| What may the Admin release? | Any amount, except what they approved: `src/server/features/payments/rules.ts` (`checkRelease`) |
| Who may do what? | `src/server/core/authorize.ts`, `docs/architecture/roles-and-permissions.md` |
| Default pay date? | `src/server/features/payments/rules.ts:426` (`defaultPayDate`) |
| How does Gmail mail become a bill? | `scripts/gmail-poll.ts` → `src/server/pipeline/intake.ts` (`ingestFromIntake`) |
| Where do the checks come from? | `src/server/dashboard/checks.ts` (`listChecks`) |
| Where does the AI stop? | Classification, extraction, coding suggestions only. Validation, duplicates, approval routing and permissions are plain code. |
