# 6 — Approvals

**Owner:** Youssef · **Code as of:** never (not yet committed)

## What it does
Takes an invoice after the analysis pass (coding, validation, duplicates) and produces an
**approval plan**: an ordered list of steps, each assigned to one person, each with the policies
and sentences that put it there. Then it gates every approve/reject on the server. Fires
`submit` (InReview → PendingApproval) or `hold` (→ OnHold) when routed, and `stepApproved` /
`stepRejected` per decision.

## Contract
- Input: `src/contracts/approvals.ts` → `ApprovalInput` (invoice id + version, vendor, dept,
  requester, submitter, PO, `totalCadCents`, flags in the shared `Flag` shape from `src/contracts/flag.ts`)
- Output: `ApprovalPlan` (`outcome: route | hold | blocked`, `steps[]`, `holdReasons[]`, `notes[]`);
  `steps` persist to `approval_steps` for that invoice version
- Policies: `ApprovalPolicy` = one `approval_policies` row (`conditions` / `steps` jsonb)
- Code: `src/server/features/approvals/` — `route.ts` (planApprovals), `decide.ts`
  (checkDecision, applyDecision, approversOf), `policies-from-csv.ts` (for the seed)
- Fixtures: none yet; tests build input from the dataset CSVs

## How it decides
1. **Routing amount** = |`totalCadCents`| (credit notes are negative). An open
   `SPLIT_INVOICE_SUSPECTED` flag from validation with `evidence.combinedCadCents` raises it.
2. **Amount chain**: the highest-priority active `chain` policy whose amount matches (P01–P04).
3. **Extra steps**: `add_step` policies — new / pending_review vendor (P05), Legal (P06), open
   `PO_OVER_BALANCE` flag (P12). Merged into an existing step of the same role, so each step lists every reason.
4. **Holds**: vendor needs a PO and there is none (P13), vendor unknown / on hold, unknown requester,
   nobody on the chain has a high enough `approval_limit`. Open `block` flags → `blocked` (stays InReview).
5. **People**: role → person (dept manager from `departments`; finance manager by role; controller =
   controller_admin with a manager; CFO = controller_admin with none), then walk up until someone can sign:
   on leave → named delegate (P08, recorded as `onBehalfOf`) · terminated → manager ·
   requester/submitter → manager (P07) · already holds a step on this invoice → manager ·
   role can't approve → manager.
6. **Decide** (`checkDecision`, called from `authorize()` / the route handler with the session user):
   refuses stale versions, held invoices, inactive users, the requester/submitter, non-approving
   roles (auditor, clerk, employee), anyone who already signed a step, anyone not assigned to the
   current step (except the delegate of an assignee who went on leave after routing). A rejection needs a reason.

No LLM anywhere in here: routing and permissions are deterministic code (`.claude/CLAUDE.md`).

## Flags it raises
None of its own. It reads `PO_OVER_BALANCE`, `SPLIT_INVOICE_SUSPECTED` and any `block` flag;
its own findings are `holdReasons` / `notes` with the policy id and the numbers, e.g.
`Liam O'Connor (U012) is on leave since 2026-10-20; routed to their delegate Elise Tremblay (U003).`

## Bad input
Unknown vendor → hold (onboard first, feature 9). USD → arrives already in CAD cents. Credit note →
routed on |amount|, note says no payment is released. Terminated requester → note. Delegate who is also
on the chain (Facilities manager's delegate is the finance manager) → the later step escalates.

## At 100× volume
Routing is map lookups over ~50 users and ~15 policies: microseconds per invoice. Store the plan
per invoice version instead of recomputing on page load; the approver queue is an indexed query on
`approval_steps (assigned_to, decision)` plus the delegate lookup.

## Known gaps
- Waiting steps are not re-routed when someone goes on leave later; `checkDecision` lets their delegate act instead.
- "New vendor" window is 90 days (`DEFAULT_NEW_VENDOR_DAYS`), a guess — admin-editable per policy.
- Admin policy editor UI not built; it edits `ApprovalPolicy` rows.
