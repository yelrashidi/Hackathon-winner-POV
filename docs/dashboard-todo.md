# Payments dashboard — to-do

Pages under `/payments`, with a sidebar and a "Viewing as" switcher. Owner: Katie (dashboard session, branch `dashboard`). Decisions: `docs/payment-decisions.md` → Dashboard decisions (see "Waiting to be recorded" below).
Target: working demo by ~7pm 2026-11-21, merged with `Katie` and tested by 9–10pm.

Everything the dashboard needs from other features sits behind one adapter and is marked `// TEMP:` until the real code exists.

Payment statuses (data model): `scheduled`, `released`, `settled`, `failed`, `cancelled`, plus `on_hold` (TEMP name: the payment session keeps holds on the payment; confirm in `docs/payment-data.md`). "Approved" is an invoice status and only appears in "Awaiting payment".

## Done

- [x] Sample data (one labelled file) + `getPayments()` server adapter.
- [x] Money/date formatters (`// TEMP:`) + status badges.
- [x] Table, summary cards, "Needs attention" and "Awaiting payment" sections, attempt history — currently all on one page; step B splits them into pages.

## Working demo (in order)

- [x] A. "Viewing as" switcher: read `users.csv` on the server, `getCurrentUser()` from a cookie (`// TEMP:`), menu in the top-right grouped Clerk / Finance Manager / Controller / Other employee (view only). Switches people, not roles; the role is always looked up on the server. (45 min)
- [x] B. Layout + sidebar: split into Overview `/payments`, To schedule `/payments/to-schedule`, Needs attention `/payments/needs-attention`. Sidebar shows only the role's pages; each page checks the same list on the server. View-only users get no Actions spots. (45 min)
- [x] C. Sample data: `on_hold` status + a held payment (same vendor as a closed account), requester on each invoice, one payment scheduled by the Finance Manager. (20 min)
- [x] D. Release queue `/payments/to-release`: per row, can the signed-in person release it? (Can release / Needs Controller over $100k CAD / You approved it / You scheduled it / You requested it). Controller also sees escalations (FRAUD_HOLD, ACCOUNT_FROZEN). `// TEMP:` copy of the release rules until the payment session's check exists. (45 min)
- [x] E. Details `/payments/[invoiceId]`: invoice + payment summary, attempt history, audit trail (sample, built from the records), why the signed-in person can or can't release. (45 min)
- [x] F. Overview filters by status and vendor (URL params, filtered on the server). (30 min)
- [x] G. Commit on `dashboard`, run `npm run dev`, click through every role. (15 min)

**Checkpoint (~7pm):** demo works end to end on sample data.

## After the checkpoint

- [x] H1. Brim-inspired theme: blue frame, turquoise accent, display font; colours in `app/payments/brim-theme.css`. (45 min)
- [x] H2. Urgency flags (critical/high/low): badges, open-flag counts, Needs attention sorted most urgent first, flags card on details, Clear flag spot for allowed people. TEMP types and sample data now match `docs/payment-data.md`. (45 min)
- [x] H3. Upload screen `/payments/upload` (AP Clerk + Controller): drop zone, one-by-one reading, original beside the form, Confirm → In review (TEMP memory store). Extraction stays behind `extraction-adapter.ts`, which answers "unavailable" until extraction exists, so every file is manual entry. (2 h)
- [ ] H. UI polish — UI is 20% of the score: spacing, hierarchy, empty states, narrow screens. (~2 h)
- [ ] I. Connect, as soon as `docs/payment-data.md` is ready (interrupts polish): `git merge Katie`, switch `getPayments()` to the real format, swap the TEMP release rules for the payment session's, put its Schedule/Release/Retry buttons in the Actions spots. (45 min)
- [ ] J. Run the demo flow (release → fail → fix bank → retry → settled) on the merged app; fix what breaks. (30 min)

Dropped: role filter (the switcher replaces it).

## Waiting to be recorded in docs/payment-decisions.md

That file isn't on this branch yet. When Katie says Katie has it, `git merge Katie`, then move these into its dashboard sections and the **Dashboard log** (newest first), and delete this section.

- UI direction (replaces "minimal, like Stripe or Ramp" and the earlier navy/teal/cyan hexes) → Brim-inspired look, feel only, no Brim logo or artwork. Blue frame (top bar + sidebar, ~#2E5A76) and turquoise accent (~#54B8D0), eyeballed from a brimfinancial.com screenshot; light grey content (#F5F7FA) with white cards; bold rounded display font (Nunito, via next/font) for page titles and summary numbers; plain-text "Brim AP" title top-left. Status badges keep their meaning colours (settled green, failed red, on hold amber, scheduled blue, released purple, cancelled grey). *Why:* UI is 20% of the score and Brim staff judge; status colours carry meaning.
- Colour details → keep the eyeballed blue (#2E5A76) and turquoise (#54B8D0); exact brand values don't matter much. Links and focus rings on white use a deeper turquoise (#1E7A90); buttons, the active page marker and focus rings on the blue frame use the bright turquoise. *Why:* bright turquoise on white is too faint to read (2.3:1); the deeper shade is 4.9:1.
- Colour tokens → stay in `app/payments/brim-theme.css` (dashboard-owned) for now. *Why:* no shared file touched, no merge conflicts. Open for the team: move them into a `@theme` block in `app/globals.css` so everyone gets classes like `bg-brim-frame`.
- Brief check → `docs/brief.md` has no branding rules (no logo, colour or name rules); the team docs have none either.
- "Viewing as" menu → grouped by type (Controller, Finance Manager, Clerk, Other employee), and you pick a person within the type. *Why:* the type gives the options; the person decides which payments you're blocked from (you can't release what you approved).
- Nobody picked → view only; the switcher says "Choose who you are". *Why:* no identity means no actions.
- Auditor → sees every page, read-only; other employees see Overview and Details only. *Why:* product.md gives the Auditor "read-only everything".
- `getCurrentUser()` → lives in `src/server/session/` (TEMP) so the payment session can import it directly.
- Details page URL → the invoice ID (`/payments/AP-00401`). *Why:* one page shows every attempt; a retry gets a new payment ID.

- Dashboard decision 1 (was "one view, role filter nice-to-have") → No login page. "Viewing as: name (role)" switcher top-right on every page; picks a person from the dataset (cookie), grouped Clerk / Finance Manager / Controller / Other employee (view only). *Why:* separation of duties depends on who approved or scheduled, so the demo must switch people, not roles. Role still comes from the employee record on the server via `getCurrentUser()` (TEMP).
- New: the dashboard is split into pages with a sidebar: Overview, To schedule (Clerk), Release queue (Finance Manager ≤ $100k CAD, larger = "Needs Controller"; Controller sees all plus escalations), Needs attention (failed + on hold), Details per payment (attempt history, audit trail, blocked reasons). *Why:* each role gets its own screen (UI is 20% of the score) and switching people visibly changes the app.
- New: the sidebar shows only the current role's pages; "Other employee" is read-only with no actions. *Why:* each role sees only what it can act on; pages also check on the server, since hiding a link isn't security.
- Unchanged: action buttons come from the payment session; the dashboard keeps TEMP "Actions" spots.
- Login and roles section → replace "Sign in as… page" with the switcher above.
- Flags display → where: tables (top open flag), Needs attention (sorted critical first), details (all flags, cleared ones greyed with who/when/note). Counts "1 critical · 3 high · 0 low" of open flags on Needs attention and the Overview card. Colours per payment-data.md: critical red, high amber, low grey. "Clear flag" spot only for people the clear rule allows (TEMP copy of the payment session's rule). Labels "Critical / High / Low", "Clear flag". *Why:* Katie's spec in payment-data.md plus the recommended defaults.
- Upload screen → built by the dashboard session on `dashboard`; page "Upload invoices" at `/payments/upload` for AP Clerk and Controller only; PDF/PNG/JPG up to 4 MB, several at once, read one at a time; original beside the form; fields: vendor, invoice number, invoice and due date, currency, PO number, ship-to province, line items, taxes, subtotal, total; unsure fields (confidence < 0.8) marked "Check this"; every field editable; vendor, invoice number, invoice date, currency, total, requester and department required; uploader picks requester and department; Confirm saves as In review (TEMP memory store, IDs UP-0001…) in Andrew's ValidationInput shape; then "Saved. {Vendor} invoice {number} is now in review." and the next file opens; until extraction exists every file is manual entry. *Why:* the recommended defaults Katie approved with "go".
- Open: how judges hand over the hidden invoices (ask the organizers).
- Dashboard log lines (newest first):
  - `Nov 21 | Upload screen | Drop zone + check-and-confirm page for Clerk/Controller; manual entry until extraction exists; saves In review | Katie`
  - `Nov 21 | Flags display | Critical/High/Low badges, open counts, most urgent first, Clear flag per payment rule | Katie`
  - `Nov 21 | Colour details | Keep eyeballed blue/turquoise; deeper turquoise for links and focus rings on white; tokens stay in the dashboard's theme file | Katie`
  - `Nov 21 | UI style | Brim-inspired blue/turquoise theme, one tokens file; status colours unchanged | Katie`
  - `Nov 21 | Switcher details | Grouped by type, pick a person; nobody = view only; Auditor sees all read-only; details URL = invoice ID | Katie`
  - `Nov 21 | Sign-in and page layout | Switcher instead of login page; split into role-specific pages with a sidebar | Katie`
