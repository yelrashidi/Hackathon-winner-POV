# Demo script — invoice to payment in ~2 minutes

Verified click by click on 2026-11-21 (headless Chrome against `npm run dev`, fresh demo database).
One person per role (and every department manager), seven roles: **Aiden Grant** (Employee, a dispatcher in Operations who reports to
Dev), **Jordan Okafor** (AP Clerk), **Dev Malhotra** (Department Manager, Operations; the other department managers sign in too), **Elise Tremblay**
(Finance Manager), **Marcus Webb** (Admin), **Priya Raman** (CFO, added 2026-11-25), **Hannah Lindqvist** (Auditor).
Switch person with the **Viewing as** menu, top right (it takes you to that person's Home).

The bill: **Polar Freight Lines Ltd. — invoice 000963 — $2,611.59 CAD** (Operations, no flags,
not a duplicate, all three lines coded with high confidence).

| # | Who | Where to click | What to say |
|---|---|---|---|
| 1 | — | Open http://localhost:3000 → **Sign in** on Jordan Okafor | One app, six roles; the role comes from the employee record on the server. |
| 2 | Jordan | Sidebar **Checks** → row **Polar Freight Lines Ltd. / 000963** | Every bill from the inbox lands here; most urgent first. |
| 3 | Jordan | **Requester** dropdown → under *Operations (this bill's department)* pick *Aiden Grant* → **Save changes** | The clerk records who ordered it — the dispatcher, not the clerk. Validation re-runs on save ("0 flag(s)"). |
| 4 | Jordan | Coding card → green **Accept 3 high-confidence** | "11 of the last 11 Polar lines → 5010 Freight"; the journal balances. |
| 5 | Jordan | Scroll → **If you submit now** shows *Waiting on Dev Malhotra* → **Submit for approval** | Routed by policy P01 (≤ $10k → department manager). Jordan can't approve it. |
| 6 | Dev | Viewing as → **Dev Malhotra** → **Approvals** → **Polar Freight Lines Ltd.** → **Approve** | Separation of duties listed on the route; delegates would show "on behalf of". |
| 6b | Aiden | *(optional, 15 s)* Viewing as → **Aiden Grant** → **My bills** shows Polar Freight *approved* → open it (who did what) → type `/checks` in the address bar | The sixth role: an employee follows the bills they asked for, read-only. Checks is "not for your role", and the server refuses any action as Aiden. |
| 7 | Jordan | Viewing as → **Jordan Okafor** → **To schedule** → **Schedule** on 000963 | AP clerks prepare; the scheduler can't release. |
| 8 | Elise | Viewing as → **Elise Tremblay** → **To release** → **Release** on 000963 | She didn't request, approve or schedule it, and it's ≤ $100k. |
| 9 | Elise | Header **Demo controls** → **Send bank answer** (Settled) on 000963 | Simulated EFT; failures (closed account, fraud hold) are in the same menu. |
| 10 | Hannah | Viewing as → **Hannah Lindqvist** → **Audit trail** → search `000963` → open it | Paid; 7 automatic control checks pass; PDF, coding, approval chain, payment, timeline. |

Shortcuts: `/demo/as/U004?next=/checks` signs in by link (demo database only). **Demo controls →
Send 3 clean bills to approval** fills Dev's queue. **Reset demo data** (Admin) starts again.

## Upload (feature 1–2 live: Claude reads a new PDF)

Setup once: put the key in **`.env.local`** at the repo root (`ANTHROPIC_API_KEY=sk-ant-…`; `.env*`
is git-ignored), then restart `npm run dev`. The Upload page's blue "Reading is off" notice
disappears when the key is picked up. File: **`fixtures/demo/polar-freight-000975.pdf`** (a new
Polar Freight invoice, $2,918.86 CAD — not in the inbox, so no duplicate).

| # | Who | Where to click | What to say |
|---|---|---|---|
| U1 | Jordan | Sidebar **Upload invoices** → drag the PDF onto the drop zone | The file is stored with its sha256 first; then Claude reads it once. |
| U2 | Jordan | Wait for **Ready to check** (10–30 s) | PDF on the left, fields filled on the right; anything under 80% confidence says **Check this**. |
| U3 | Jordan | **Requester** → *Jordan Okafor*, **Department** → *Operations* (Ship-to → *ON* if empty) → **Confirm invoice** | Nothing is saved until a person confirms against the original. |
| U4 | Jordan | Green message → **Open it in Checks →** | Validation and coding already ran: vendor matched, 3 lines coded "High". |
| U5 | | Continue with steps 4–10 above (Accept 3 high-confidence → Submit → Dev approves → …) using invoice **000975** | |

If the key fails, the form opens empty with the reason (manual entry, never a guess) — type:
000975 · 2026-11-14 · due 2026-12-14 · CAD · lines 1,412.50 / 968.20 / 202.36 · HST13 335.80 ·
subtotal 2,583.06 · total 2,918.86.
