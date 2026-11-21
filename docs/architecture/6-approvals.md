# 6 — Approvals

**Owner:** Youssef · **Code as of:** `fb86afa` · Every edge case, with `file:line` and test:
[`6-approvals-edge-cases.md`](6-approvals-edge-cases.md)

## What it does
Takes an invoice after the analysis pass (coding, validation, duplicates) and produces an
**approval plan**: ordered steps, each assigned to one person, each with the policies and
sentences that put it there. Then it gates every approve/reject on the server. Fires `submit`
(InReview → PendingApproval) or `hold` (→ OnHold) when routed, and `stepApproved` /
`stepRejected` per decision. After routing it answers two more questions: does this edit void
the approvals (`reapprovalReasons`), and is this approval sitting too long (`approvalAging`)?

## Contract
- Input: `src/contracts/approvals.ts` → `ApprovalInput`: invoice id + version, vendor, dept,
  requester, submitter, PO + PO requester, `conflicts` (people not independent of it), currency /
  total / FX rate / CAD total, line departments, YTD department spend, flags (`src/contracts/flag.ts`)
- Output: `ApprovalPlan`: `outcome: route | hold | blocked`, `steps[]`, `basis` (what is being
  approved: payee, currency, amount, requester, PO), `excludedApprovers[]`, `attention[]`
  (exceptions to acknowledge), `holdReasons[]`, `notes[]`, `routedAt`
- Each step records `actedBy`, `onBehalfOf`, `actedAs` (name/role/limit **at that moment**),
  `acknowledgedFlags`, `comment`, `decidedAt`
- Policies: `ApprovalPolicy` = one `approval_policies` row; the schema rejects nonsense rows
- Code: `src/server/features/approvals/` — `route.ts` (planApprovals), `resolve.ts` (who signs,
  shared by routing and decisions), `decide.ts` (checkDecision, applyDecision, approversOf,
  waitingOn), `lifecycle.ts` (reapprovalReasons, approvalAging), `policies-from-csv.ts` (seed)
- Tests: `__tests__/approvals.test.ts`, 116 cases incl. a 3,000-invoice randomized org-chaos test

## Separation of duties — every rule, and where it is enforced
| Rule | Routing (`route.ts` / `resolve.ts`) | Decision (`checkDecision`) |
|---|---|---|
| No approving your own request (P07) — incl. one you submitted or whose PO you requested | → their manager | `SELF_APPROVAL` 403 |
| Not independent: overrode a flag, maintains the vendor (onboarded / changed its bank details), the purchase is for them | → their manager | `CONFLICT_OF_INTEREST` 403 |
| A delegate never signs for an excluded person | exclusions checked **before** delegation | same resolver |
| One person, one signature per invoice (incl. via a delegate) | `taken` set, escalate | `ALREADY_SIGNED` 403 |
| Only approver / finance / controller roles sign | escalate past others | `ROLE_CANNOT_APPROVE` 403 |
| Only the current step's person, as of **today** | — | re-resolved live: `NOT_ASSIGNED` 403 |
| Delegate actions recorded as such (P08) | `onBehalfOf` | `actedBy` + `onBehalfOf` + `actedAs` |
| The chain must carry the amount | last step escalates past low limits; else hold | `INSUFFICIENT_AUTHORITY` 403 |
| You cannot approve exceptions you did not look at | `attention[]` | `FLAGS_NOT_ACKNOWLEDGED` 409 |
| Approver cannot release the payment (P11) | — | `approversOf(...allPlans)` for step 7 |

## How it decides
1. **Amounts**: CAD total must equal total × FX rate (±1¢); CAD has rate 1, USD must not. Else hold.
2. **Routing amount** = |CAD total|, raised to the highest `combinedCadCents` of any unresolved
   `SPLIT_INVOICE_SUSPECTED`; a split flag with no usable total adds a finance-manager step.
3. **Chain**: highest-priority active amount policy (P01–P04); ties go to the longer chain.
4. **Extras**: P05 (pending_review, onboarded ≤ 90 days, missing / future / unreadable date), P06,
   P12 (`PO_OVER_BALANCE` open **or overridden**), P13 hold; optional admin rule `department_over_budget`.
5. **People** (`resolve.ts`): every holder of the role as-is, then walk up from the first:
   excluded → manager · already on the chain → manager · terminated / suspended → manager ·
   on leave → delegate, **one hop**, on behalf of · delegate unusable → the **absent person's**
   manager · role cannot approve → manager · limit too low (last step) → manager. Loops detected.
   Nobody new left but someone on the chain could sign → one signature covers both (`alsoCovers`).
6. **Decide**: validates the body, the stored plan, invoice id / version / status, the actor,
   re-resolves the step against today's directory (leave, return, termination, limit changes
   self-heal), requires every `attention` code acknowledged, snapshots the approver's authority.

No LLM anywhere in here: routing and permissions are deterministic code (`.claude/CLAUDE.md`).

## Real-world controls beyond the brief
| Problem in real AP | What step 6 does |
|---|---|
| Approved $3,000, paid $3,900 after a "corrected" invoice | `reapprovalReasons`: any increase over the lesser of 2% / $100, a payee / currency / dept / requester / PO change, a new exception, a newly required role, or an approver who is now conflicted → void and resubmit. Decreases never need it. `basis` tells step 7 the most it may pay, and to whom. |
| Employee creates a fake vendor, then approves its invoices | `conflicts` from feature 9 (vendor onboarder, bank-change requester/verifier) are excluded |
| Boss has their assistant "request" their own purchase | `conflicts` "is the person this purchase is for" → the boss cannot approve |
| "I approved it, I never saw the price was over contract" | `attention[]` must be acknowledged code by code; stored on the step |
| CRA asks a year later whether the approver had authority then | `actedAs` snapshots name, role, limit at decision time |
| Rejected invoice resubmitted unchanged, hoping for a different answer | `history` → note with who rejected, when and why; "resubmitted with no change since" |
| Approvals sit until the due date / 2-10-net-30 discount passes (72 of 426 in history) | `approvalAging`: business-day reminders, escalation notice to the manager; notify only, never reassigns |
| Department blows its annual budget | note with the % (one decimal); admin can make it a finance-manager step |

## Flags it reads
`block` flags (open → `blocked`; overridden needs `resolvedBy`, else still blocked), `warn` and
overridden flags (→ `attention`), `PO_OVER_BALANCE`, `SPLIT_INVOICE_SUSPECTED`
(+ `evidence.combinedCadCents`). Its own findings are `holdReasons` / `notes` with names and numbers.

## Bad input
| Input | Result |
|---|---|
| Unknown / on-hold / unknown-status vendor | hold (approve refused if it goes on hold later; reject still works) |
| Unknown, terminated or auditor requester; unknown department | hold |
| Unconverted USD, sign flip, CAD with an FX rate | hold |
| Amount over every limit ($600k) | hold |
| Credit note | routed on \|amount\|, note: no payment is released |
| $0 total | routed, note: check extraction |
| Requester in another dept / lines charged elsewhere / approver reports to requester / over budget | routed, note |
| Malformed body, corrupt stored plan, wrong invoice, stale version, not pending | 400 / 409 with a reason |

## At 100× volume
Routing is map lookups over ~50 users and ~15 policies: microseconds per invoice. Store the plan
per invoice version. The approver queue is `approval_steps (decision = 'pending')` through
`waitingOn()`; at scale, materialize "waiting on" and refresh it when a user's status changes.
`approvalAging` runs as a daily job over pending plans only.

## Decisions made here (veto at kickoff if you disagree)
- Collapse two roles onto one person only when no one else is eligible (instead of a dead-end hold).
- Delegation is one hop. New-vendor window 90 days. Terminated requester → hold.
- Whoever overrides a flag cannot approve the invoice; overridden flags still drive routing.
- Re-approval tolerance: lesser of 2% and $100 (`REAPPROVAL_TOLERANCE`).
- Aging: remind after 2 business days, escalate after 5 or within 3 days of the due date.

## For the route handler and teammates (not in this pure code)
- Load plan + invoice **in the same transaction** as the write; the actor comes from the session.
- Write the step with `WHERE seq = $n AND decision = 'pending'`; 0 rows → 409 (two clicks).
- Every resubmit is a new plan; keep old plans (audit trail, `approversOf`, `history` notes).
- On an invoice edit, call `reapprovalReasons`; non-empty → bump `invoices.version`.
- Feature 9 supplies `conflicts`; validation supplies `SPLIT_INVOICE_SUSPECTED.combinedCadCents`
  and `PO_OVER_BALANCE`; step 7 checks payee and amount against `basis` and P11 via `approversOf`.

## Known gaps
- Admin policy editor UI not built. Public holidays are not in the business-day count.
- Policy changes do not re-route invoices already in flight (the plan keeps its policy version).
- Reciprocal approvals (A approves B's, B approves A's) and rubber-stamping are analytics, not routing.
