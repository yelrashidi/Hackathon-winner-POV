# 1 — Intake

**Owner:** Arpan · **Code as of:** `949ce76` + Gmail → dashboard (2026-11-21; steps 1–2 of 4 done; step 3 mostly via `ingestFromIntake`, rest in `docs/todo/TODO.md`)

## What it does
Watches a mailbox, turns every new email into one `InboxMessage`, classifies it (invoice / not an
invoice / no attachment, with a reason), and turns each invoice attachment into a **draft bill**
(`Received`) for the clerk's inbox dashboard. Non-invoices are kept with their reason, out of the
bill queue; emails with no attachment are routed to the clerk, not dropped.

Build order: **1 Gmail connector** (done) → **2 classifier** (done) → 3 intake tables + draft bill → 4 inbox dashboard.

## Contract
- Output of the connector: `src/contracts/intake.ts` → `InboxMessage` (source, externalId, from,
  subject, receivedAt, bodyText, attachments with a `sourceRef` to fetch bytes — never the bytes).
- Two sources, one shape: live Gmail (`src/server/features/intake/gmail/parse.ts`) and the
  dataset's `inbox/emails.json` (`src/server/features/intake/dataset/emails.ts`). Hidden scoring
  data arrives as the latter, so both go through the same classifier.
- Later: persisted to `inbox_messages` / `documents` / `invoices` (step 3).
- Frozen outputs: `fixtures/intake/*.json` (`IntakeClassification`) and `fixtures/intake/messages/*.json` (`InboxMessage`). `npm run fixtures:intake` replays saved extraction replies without API calls; `-- --live` captures three new document reads. `src/contracts/__tests__/intake-fixtures.test.ts` parses and replays every fixture.
- Both CLI runners share terminal formatting in `scripts/intake-print.ts:9` (`printResult`); it is an imported helper, not a standalone command.

## How it decides (connector)
- **Auth:** OAuth "Desktop app" client, scope `gmail.readonly` only — intake cannot send, delete
  or relabel mail (`src/server/features/intake/gmail/client.ts:10`). Refresh token in `.env.local`.
- **Polling, not push:** `pollGmail` (`src/server/features/intake/gmail/poll.ts`) keeps Gmail's
  `historyId` as a cursor; `history.list` returns only messages added to INBOX since then.
  First run records "now" — a personal inbox is never backfilled unless asked: `--backfill 1d`, or
  `GMAIL_BACKFILL=1d` which applies only when there is no cursor yet (`scripts/gmail-poll.ts:34`, BUG-Arpan-07).
  Expired cursor (Gmail keeps ~7 days) → reset to now, reported.
- Drain every history and backfill page and fetch every unique message before returning a cursor (`gmail/poll.ts:65`, `:102`). `maxMessages` sets the backfill page size, never a total delivery cap (BUG-Arpan-02). A failed fetch rejects the poll so no new cursor is returned to save.
- Sent mail and drafts are skipped. A message failing the contract is returned in `rejected` with
  the Zod reason, never silently dropped.
- Re-delivery is safe: storage will be unique on `(source, externalId)`.

## How it decides (classifier)
Output: `IntakeClassification` (`src/contracts/intake.ts`) — `decision` (`invoice` / `needs_review` /
`ignored`), `kind`, `reason` shown verbatim, `invoiceAttachments` (one draft bill each), `documents`
(verdict per attachment), `decidedBy` (`rules` / `llm` / `fallback`), `signals` (stable rule codes).

**The email's wording never makes a bill.** (2026-11-21: it used to, so "Invoice attached" + a
brochure drafted a bill for the brochure.)

- **Email with document attachments** → each document is read on its own by extraction's
  `readDocument` ([`2-extraction.md`](2-extraction.md)). Only documents that are invoices or credit
  notes go into `invoiceAttachments`; the others stay visible with their reason
  (`decideFromDocuments`, `src/server/features/intake/classify/classify.ts`).
- **Email without a readable document** → `src/server/features/intake/classify/rules.ts`: EN+FR word
  lists (invoice, receipt, marketing, statement, payment question; accent-stripped, whole words;
  "due upon receipt" is not a receipt) and sender domain vs vendor master settle missing attachment /
  vendor inquiry / statement / receipt / marketing / personal. The rest → Claude reads the email text
  (`classify/prompt.ts`, `classify/claude.ts`; effort low; email in `<email>` tags as data). Guard: this
  classifier can never create a bill. Claude fails twice → `needs_review` with the error. Never dropped.
- The sender check is the email domain only. The vendor printed on the PDF is matched by validation
  (`src/server/features/validation/vendor-match.ts`) after extraction.

Dataset, text rules only (`npm run intake:dataset -- --no-llm`): 59 emails → 54 bills from text PDFs
(52 invoices, 2 credit notes) + 2 PNG scans uncertain (need the model); EM-058 missing attachment,
EM-057 vendor inquiry, EM-056 statement → review; EM-059 marketing → ignored.

## Gmail setup
One-time, ~10 minutes, per developer:
1. <https://console.cloud.google.com> → new project → **APIs & Services → Library** → enable **Gmail API**.
2. **OAuth consent screen**: External, app name "Harborline AP (dev)", add your Gmail as a **test user**.
3. **Credentials → Create credentials → OAuth client ID → Desktop app**. Copy id and secret into
   `.env.local` (gitignored):
   ```
   GMAIL_CLIENT_ID=…apps.googleusercontent.com
   GMAIL_CLIENT_SECRET=…
   ```
4. `npm run gmail:auth` → open the printed URL → approve. The refresh token is written to `.env.local`.
5. `npm run gmail:poll` (records baseline) → send yourself an email with a PDF → `npm run gmail:poll`
   again. Or `npm run gmail:poll -- --watch 30`, or `-- --backfill 1d` to see today's mail.

6. For classification with Claude, add `ANTHROPIC_API_KEY=…` to `.env.local` (`--no-llm` runs rules only).
7. **Saving:** with Postgres up (`.env` from `.env.example`, `npm run db:up && npm run db:reset`), both
   `gmail:poll` and `intake:dataset` save every email through `ingestFromIntake`
   (`src/server/pipeline/intake.ts`, shared glue in `scripts/intake-save.ts`): readable bill → validated,
   coded, audited (`InReview`); unreadable bill → `ManualEntry`; each bill gets a `documents` row (sha256).
   Re-running is safe (no duplicates). `--no-save` only prints. Gmail's cursor advances only after every
   new email is saved.
8. **In Docker:** `docker compose up -d` also starts the `gmail-poller` service (`docker-compose.yml`):
   `gmail:poll --watch` every `GMAIL_POLL_SECONDS` (default 10) as `ap_app`, keys from `.env.local`, cursor
   in the `intake-state` volume. Its first poll (no cursor) backfills `GMAIL_BACKFILL` (default `1d`), so
   bills already in the inbox reach the dashboard; after that it is incremental. No Gmail keys → it logs why and
   exits 0. `--watch` waits for each poll to finish before the next (`scripts/gmail-poll.ts`), so a slow
   LLM read never overlaps the next poll on the same mail. Logs: `docker compose logs -f gmail-poller`.
9. **On the dashboard:** a saved bill is an `InReview` (or `ManualEntry`) invoice, so it shows in **Checks**
   and on Home's **Next checks**, marked "from email", with its open flag codes as tags
   (`src/server/dashboard/checks.ts` `flagTags`; `CODING_NOT_CONFIRMED` is left out — the row text covers it).
   Emails that are not bills stay in **Inbox** with intake's reason.

Traps:
- "Access blocked: … has not completed the Google verification process" → the signing-in account is
  not a **test user** (Audience → Test users), or the app was set to "In production". Keep it in Testing.
  Then click *Advanced → Go to … (unsafe)* on the "unverified app" screen.
- In **Testing**, Google expires refresh tokens after **7 days**. `invalid_grant` → rerun `npm run gmail:auth`.

## Flags it raises
None in `invoice_flags` yet: intake records stable `signals` (`ATTACHMENT_DOCUMENT`, `NO_ATTACHMENT`,
`INVOICE_TERMS`, `RECEIPT_TERMS`, `KNOWN_VENDOR_SENDER`, `GUARD_NO_DOCUMENT`, `LLM_FAILED`…) and a reason.
Step 3 adds `DOCUMENT_TYPE_UNCERTAIN` (warn) on an invoice created from an uncertain document:
`Could not tell whether scan_1.png is a bill: text says invoice, model says receipt.`

## Bad input
- HTML-only email → tags stripped to text. Inline tiny attachments → addressed by MIME part id.
- No attachment → kept, `attachments: []` (rules or Claude route it; never a bill).
- "Invoice attached" + a non-invoice PDF → the PDF is read and not drafted (BUG-Arpan-01).
- Logo / signature images (< 20 KB), .docx/.xlsx → not documents; named in the reason.
- Attachment download fails → that document is `uncertain`, the email goes to review.
- French subjects and bodies → accent-stripped EN+FR word lists.
- Email text is data, never instructions (`docs/rules/backend.md`).
- Mail that arrived before the poller's first run → read by the first-run backfill (`GMAIL_BACKFILL`); anything older needs a manual `--backfill` (BUG-Arpan-07).

## At 100× volume
Polling one mailbox is cheap (O(new mail)). Many mailboxes or near-real-time → Gmail `watch` +
Pub/Sub push into a queue table, same `pollGmail` code drains it. Attachment bytes fetched lazily,
stored once by sha256.
The current CLI drains a backlog serially. For large backlogs, persist a queue plus its cursor in one transaction, then classify bounded batches; never advance a cursor while discarding unfetched messages.
A large `GMAIL_BACKFILL` window on a busy inbox means one classification (and possibly one Claude read) per email on first start; keep it at `1d`.

## Known gaps
- Whole personal inbox is read (team decision 2026-11-21); the classifier must pre-filter
  before anything is sent to the LLM.
- Cursor lives in `.intake/gmail-state.json` until the intake tables exist (step 3).
- Vendor domains are injected into classification. `intake/dataset/vendors.ts` is a development/fixture adapter only; deployed intake must supply the database-backed vendor context (tracked in TODO step 3).
- Nothing persisted yet; an uncertain document next to a bill is only listed under its email
  until step 3 makes it its own dashboard item.
- Lookalike sender domains: flagged by validation, not intake (needs `fromAddress` passed through).
