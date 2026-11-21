# 6 — Approvals: study guide for the Q&A

**Owner:** Youssef · **Written:** 2026-11-21 · **Code as of:** `a896a64`

Everything you need to explain feature 6 under questioning: what it does, every function, how the
logic runs, why it was built this way, and answers to the questions judges are likely to ask.
Companion docs: [`6-approvals.md`](6-approvals.md) (design), [`6-approvals-edge-cases.md`](6-approvals-edge-cases.md)
(every edge case with `file:line` and test). Code paths below are under `src/server/features/approvals/`.

---

## 0. The 30-second answer

> "Step 6 decides **who has to approve an invoice, in what order, and why**, and then **enforces that
> on the server**. It is plain TypeScript functions, no LLM. `planApprovals` turns an invoice plus the
> company's users and policies into a *plan*: ordered steps, each one person with the policy reasons
> behind it. `checkDecision` is the single gate every approve/reject request goes through; it refuses
> self-approval, the wrong person, people who are not independent, and approvals that skip the
> exceptions. A small store saves plans and decisions. Separation of duties is enforced twice: when the
> plan is built, and again at every click."

## 1. Where it sits in the pipeline

```
1 intake → 2 extraction → 3 coding / 4 validation / 5 duplicates → 6 APPROVALS → 7 payments → 8 audit
```

- **In:** the invoice after steps 1–5 (amount in CAD, vendor, department, requester, flags raised by validation/duplicates).
- **Out:** an `ApprovalPlan`. Its `outcome` tells the state machine what to do:
  - `route` → fire `submit` (InReview → PendingApproval)
  - `hold` → fire `hold` (→ OnHold), with `holdReasons`
  - `blocked` → stay in InReview (an open blocking flag must be resolved first)
- **Each click:** `stepApproved` (→ PendingApproval, or Approved if it was the last step) or `stepRejected` (→ InReview).
- **Used by payments (step 7):** `approversOf()` (who approved, so they cannot release the payment: P11) and `plan.basis` (pay no more than this, to no other payee).
- **Used by the UI:** `waitingOn()` (whose queue), `steps[].reasons` / `resolution` (why each person), `attention` (exceptions to acknowledge), `notes`.

## 2. The files

| File | What it holds | Main exports |
|---|---|---|
| `src/contracts/approvals.ts` | Zod schemas: the shapes that cross feature boundaries | `ApprovalInput`, `ApprovalPlan`, `ApprovalStep`, `ApprovalPolicy`, `SPLIT_FLAG_CODE` |
| `src/contracts/flag.ts` | The one flag shape every stage uses | `Flag` |
| `directory.ts` | The reference data approvals reads (users, departments, vendors, policies) and small helpers | `ApprovalContext`, `APPROVING_ROLES`, `formatCad`, `clip` |
| `route.ts` | Builds the plan | `planApprovals` |
| `resolve.ts` | Picks the person for each step (the heart) — shared by routing and decisions | `resolveRole`, `resolveFrom`, `candidatesFor`, `effectiveAssignee`, `signersOf` |
| `decide.ts` | The approve / reject gate | `checkDecision`, `applyDecision`, `approversOf`, `currentStep`, `waitingOn`, `isAwaiting` |
| `lifecycle.ts` | After routing: edits and waiting time | `reapprovalReasons`, `approvalAging`, `businessDaysBetween` |
| `store.ts` | Saving and loading plans and decisions | `saveApprovalPlan`, `getApprovalPlans`, `getCurrentApprovalPlan`, `saveDecision`, `importApprovalPlan` |
| `policies-from-csv.ts` | Turns `approval_policies.csv` text into structured rules (for the seed) | `policiesFromCsv` |
| `index.ts` | The public surface: other features import only from here | everything above |
| `__tests__/` | 137 tests: behaviour, fixtures, store | — |
| `fixtures/approvals/` | 5 frozen plans other features build against | — |

## 3. The data shapes (contracts)

### `ApprovalInput` — what step 6 needs from steps 1–5
| Field | Why it exists |
|---|---|
| `invoiceId`, `invoiceVersion` | Which invoice; the version changes on a material edit, which voids approvals |
| `vendorId` (or null), `vendorNameRaw` | Vendor-master match; null = unknown vendor → hold |
| `departmentId` | Whose department manager approves (P01) |
| `requesterId`, `submittedBy`, `poRequesterId` | People who may **never** approve this invoice ("self") |
| `conflicts` | Other people who are not independent: vendor-master maintainers, the person a purchase is for |
| `currency`, `totalCents`, `fxRateToCad`, `totalCadCents` | Amount; CAD is what limits compare against. Re-checked: an unconverted USD total would route too low |
| `poId` | P13 (vendor requires a PO) |
| `lineDepartmentIds`, `departmentSpendYtdCadCents` | Notes only: other departments charged, budget overrun |
| `flags` | From validation / duplicates; drive blocking, extra steps, and exceptions to acknowledge |

### `ApprovalPlan` — the output
| Field | Meaning |
|---|---|
| `planId` | Set by the store when saved; decisions are tied to it |
| `outcome` | `route` / `hold` / `blocked` |
| `routingCadCents` | The amount used to pick the tier: \|CAD total\|, raised by a split-invoice flag |
| `steps[]` | Ordered approval steps (below) |
| `basis` | What is being approved: `vendorId`, `currency`, `totalCents`, `totalCadCents`, `requesterId`, `poId`. Payments must not exceed it |
| `excludedApprovers[]` | Who may not sign and why (`kind: self` or `conflict`) |
| `attention[]` | Exceptions the approver must acknowledge (unresolved warnings, overridden flags) |
| `holdReasons[]`, `notes[]` | Why it is held / context for approvers |
| `routedAt`, `departmentId`, `invoiceVersion` | When, which department, which version |

### `ApprovalStep` — one row of `approval_steps`
`seq`, `role` (dept_manager / finance_manager / controller_admin / cfo), `alsoCovers` (extra roles this
signature covers), `policyId` + `policyVersion`, `reasons[]` (each policy that wants this step, with a
sentence), `routedTo` (who the policy pointed at), `assignedTo` (who must act), `onBehalfOf` (absent
approver, when a delegate acts), `resolution[]` (how routedTo became assignedTo), and after the
decision: `decision`, `actedBy`, `actedAs` (name/role/limit **at that moment**), `acknowledgedFlags`,
`comment`, `decidedAt`.

### `Flag` status — a subtle point you will be asked about
- `open`: the problem is live. A `block` flag stops routing.
- `resolved`: fixed (e.g. the PO was amended). Ignored.
- `overridden`: someone accepted it **without** fixing it. A block flag stops blocking, but the condition
  is still true, so rules keyed on it (P12) still apply, it must be acknowledged, and **whoever overrode
  it cannot approve the invoice**.

### `ApprovalPolicy` — one editable rule
`conditions` (e.g. `amount_over 1,000,000 cents`, `vendor_category Legal`, `flag_raised PO_OVER_BALANCE`)
and `steps` (effect: `chain [roles]`, `add_step role`, `hold`, …). Seeded from the CSV by
`policiesFromCsv`; afterwards the Controller edits rows, no deploy. The schema refuses nonsense rows
(a chain not keyed on an amount; a payment rule filed as an approval rule).

## 4. Function reference

### Routing
- **`planApprovals(input, ctx, history?) → ApprovalPlan`** (`route.ts:59`). Pure: same input, same plan.
  `ctx` = users, departments, vendors, policies, `asOf` (today). `history` = the invoice's earlier
  plans, so approvers see earlier rejections.

### The people resolver (`resolve.ts`)
- **`candidatesFor(role, dept, ctx)`** (`:116`): who holds a role. dept_manager = the department's
  manager; finance_manager = users with that role; controller_admin = controller_admins *with* a manager
  (CFO as fallback); cfo = the controller_admin with **no** manager. Active people first.
- **`resolveFrom(start, opts, ctx, escalate)`** (`:65`): walks from one person to someone who can sign
  (order in section 6).
- **`resolveRole(role, dept, opts, ctx)`** (`:140`): pass 1 tries every holder as-is (incl. their
  delegate); pass 2 escalates from the first.
- **`effectiveAssignee(plan, step, ctx)`** (`:186`): who may act on a step **right now**, re-resolved
  against today's directory.
- **`signersOf(steps)`** (`:162`): everyone who signed or was signed for. **`signedAuthority`** (`:173`): highest limit among actual signers.

### The decision gate (`decide.ts`)
- **`checkDecision(plan, invoice, actorId, body, ctx) → ok | denied`** (`:91`): the only gate. `body`
  is untrusted JSON. Denied results carry `status` (400/403/409), `code`, `reason`.
- **`applyDecision(plan, check, now) → DecisionResult`** (`:200`): records exactly what was checked
  (actor + action come from the check, not separate arguments). Returns the new steps, the `event` for
  `fire()`, `isLastStep`, and `planId`. Throws if the step is no longer pending.
- **`approversOf(...plans) → Set`** (`:226`): everyone who approved, incl. on-behalf-of, across all rounds. For P11.
- **`currentStep(plan)`** (`:79`), **`waitingOn(plan, invoice, ctx)`** (`:233`), **`isAwaiting(plan, userId, invoice, ctx)`** (`:244`): for queues and "waiting on X" labels.

### After routing (`lifecycle.ts`)
- **`reapprovalReasons(approvedPlan, editedInput, ctx) → reasons[]`** (`:25`): empty = the edit keeps
  the approvals; otherwise bump the invoice version (voids them).
- **`approvalAging(plan, now, ctx, opts) → Aging`** (`:129`): business days waiting, days to due date /
  discount, level `on_time` / `remind` / `escalate`, who to notify. Notifies only; never reassigns.
- **`businessDaysBetween(from, to)`** (`:111`): weekdays only (holidays not modelled).

### Storage (`store.ts`) — all async, optional `{ store }` for a transaction-bound store
- **`saveApprovalPlan(plan)`** (`:151`): append a fresh plan. Refuses plans that already contain decisions.
- **`getApprovalPlans(invoiceId)`** (`:191`): every plan, oldest first.
- **`getCurrentApprovalPlan(invoiceId, { invoiceVersion })`** (`:202`): latest plan for that version; null if edited and not resubmitted.
- **`saveDecision(invoiceId, invoiceVersion, result)`** (`:212`): conditional write of one decision.
- **`importApprovalPlan(plan)`** (`:165`): seed / tests only.
- **`ApprovalStore`** (`:57`): the 4 methods a database must implement; **`InMemoryApprovalStore`** (`:72`) is the `// TEMP: db` one; **`ApprovalStoreError`** (`:115`) maps to 404 / 409 / 400.

### Seed
- **`policiesFromCsv(rows)`** (`policies-from-csv.ts:23`): CSV text → structured policies; fails loudly on a row it does not understand.

## 5. How `planApprovals` works, step by step

| # | Stage | What it does |
|---|---|---|
| 0 | Blocking flags | Open `block` flags → outcome will be `blocked`. An override with no name stays blocking |
| 0 | Currency check | CAD must have rate 1 and CAD total = total; USD must not have rate 1 and must convert within 1¢. Else hold |
| 1 | Routing amount | \|CAD total\| (credit notes are negative); raised to the highest `combinedCadCents` on a split flag |
| 2 | Exclusions | requester / submitter / PO requester (self); conflicts and flag overriders (conflict) |
| 3 | Sanity | requester exists, is active (not terminated) and may request; department exists; vendor known and active / pending_review; budget note |
| 4 | Amount chain | highest-priority amount policy that matches: P01–P04 |
| 5 | Extra steps / holds | P05 new or pending vendor, P06 Legal, P12 PO over balance → add finance_manager; P13 PO missing → hold |
| 6 | People | for each role, in order dept → finance → controller → CFO: `resolveRole`; the last step must carry the full amount (limit) |
| 7 | Authority | someone on the chain must have a limit ≥ routing amount, else hold |
| 8 | Context | notes: approver reports to requester, earlier rejections, cross-department charging |

### Traced: Facilities rent, $18,758.00 (the `facilities-delegate` fixture)
Requester Kavya (U037), department D07 Facilities. Liam (U012) manages Facilities but is on leave;
his delegate is Elise (U003), who is also the finance manager.

1. $18,758 > $10,000 → **P02**: chain = dept_manager, finance_manager.
2. **dept_manager**: Liam → on leave → delegate Elise.
   *"Liam O'Connor (U012) is on leave since 2026-10-20; routed to their delegate Elise Tremblay (U003)."* → Elise, **on behalf of Liam**.
3. **finance_manager**: Elise → already holds step 1 → escalate to her manager.
   *"Elise Tremblay (U003) already signs another step on this invoice; escalated to their manager Marcus Webb (U002)."*
4. Authority: Marcus's limit $250,000 ≥ $18,758 ✓. Outcome `route`.
5. After approval, step 1 records `actedBy U003, onBehalfOf U012, actedAs {Elise Tremblay, finance_manager, $50,000}`.
   `approversOf` = {U003, U012, U002}: **none of them may release the payment.**

## 6. The resolver: the heart of the design

For each person, checks run **in this order** (`resolve.ts:47`):

1. **Excluded** (requester, submitter, PO requester, conflict) → escalate to their manager
2. **Already holds a step** on this invoice → escalate
3. **On leave** → their named delegate (P08), **one hop only**, recorded as on behalf of
4. **Terminated / suspended / unknown status** → escalate
5. **Role cannot approve** (employee, AP clerk, auditor) → escalate
6. **Limit too low** for a step that must carry the whole amount → escalate

Why the order matters: if "on leave" were checked before "excluded", a delegate could approve their
absent boss's **own** purchase "on his behalf": Liam approving Liam. That was a real bug
(BUG-Youssef-01); exclusions now come first.

Other rules:
- If a **delegate** cannot sign, it escalates to the **absent person's** manager, not the delegate's manager.
- Pass 1 tries every holder of a role before escalating (two finance managers: if one is the requester, the other signs).
- `manager_id` loops are detected (no infinite loop); running out of managers → hold with the reason.
- **Collapse (`alsoCovers`)**: only when nobody new is eligible but someone already on the chain could
  sign the role. Example: Finance department, $300,000. Marcus is both Finance's manager *and* the
  Controller, so 4 roles have 3 people: Marcus (dept), Elise (finance), Priya (controller **and** CFO).

## 7. The decision gate: `checkDecision`, in order

| # | Check | Code | HTTP |
|---|---|---|---|
| 1 | Body is valid (`action` exactly approve/reject, comment text ≤ 2,000, `acknowledgedFlags` a list) | `INVALID_REQUEST` | 400 |
| 2 | Stored plan valid, no duplicate step numbers | `CORRUPT_PLAN` | 409 |
| 3 | Plan belongs to this invoice | `WRONG_INVOICE` | 409 |
| 4 | Plan's version = invoice's version | `STALE_PLAN` | 409 |
| 5 | Invoice status is PendingApproval | `NOT_PENDING` | 409 |
| 6 | Plan outcome is route | `NOT_ROUTED` | 409 |
| 7 | There is a pending step (nothing rejected) | `ALREADY_DECIDED` | 409 |
| 8 | Actor exists / is active | `UNKNOWN_USER` / `USER_INACTIVE` | 403 |
| 9 | Actor is not excluded | `SELF_APPROVAL` / `CONFLICT_OF_INTEREST` | 403 |
| 10 | Actor's role can approve | `ROLE_CANNOT_APPROVE` | 403 |
| 11 | Actor has not signed another step (incl. via delegate) | `ALREADY_SIGNED` | 403 |
| 12 | Somebody can sign this step today | `NO_ELIGIBLE_APPROVER` | 409 |
| 13 | That somebody is the actor | `NOT_ASSIGNED` | 403 |
| 14 | Reject has a reason | `COMMENT_REQUIRED` | 400 |
| 15 | Approve acknowledges every `attention` code | `FLAGS_NOT_ACKNOWLEDGED` | 409 |
| 16 | Vendor still payable (reject still allowed) | `VENDOR_NOT_PAYABLE` | 409 |
| 17 | Last step: signers' limits cover the amount | `INSUFFICIENT_AUTHORITY` | 403 |

The actor id comes from the **server session**, never the request body. The route handler then calls
`applyDecision`, `saveDecision` (conditional write) and `fire()`, in one transaction.

## 8. Separation of duties: the cheat sheet

| Rule | Routing | Click |
|---|---|---|
| Nobody approves what they requested / submitted / whose PO they requested | escalate to manager | `SELF_APPROVAL` |
| Not independent (overrode a flag, maintains the vendor, purchase is for them) | escalate | `CONFLICT_OF_INTEREST` |
| A delegate never signs for an excluded person | exclusions before delegation | same |
| One person, one signature per invoice (incl. through a delegate) | escalate | `ALREADY_SIGNED` |
| Only approver / finance manager / controller roles sign | escalate | `ROLE_CANNOT_APPROVE` |
| Only today's assignee for the current step | — | `NOT_ASSIGNED` |
| Delegate actions recorded as such | `onBehalfOf` | `actedBy` + `onBehalfOf` + `actedAs` |
| Approver cannot release the payment (P11) | — | `approversOf` → step 7 |

**Can an admin turn self-approval off?** No. P07 is enforced whether or not its policy row is active; the
brief requires it. There is no "override" or "force approve" path anywhere.

## 9. Policies → code

| Policy | Rule | Where |
|---|---|---|
| P01–P04 | Amount tiers: ≤ $10k dept manager; > $10k + finance; > $50k + controller; > $250k + CFO | `chain` policies, `route.ts:326` |
| P05 | New (≤ 90 days, or unknown / future date) or pending-review vendor → + finance | `route.ts:349` |
| P06 | Legal vendor → + finance | `route.ts:360` |
| P07 | Requester is the approver → their manager | `resolve.ts:48` |
| P08 | On leave → named delegate | `resolve.ts:86` |
| P09–P11 | Payment release (finance ≤ $100k, controller > $100k, never an approver) | step 7, via `approversOf` |
| P12 | Over the PO's remaining balance → + finance | `flag_raised PO_OVER_BALANCE` |
| P13 | Vendor requires a PO, none given → hold | `route.ts:365` |

## 10. More worked examples

| Invoice | Result | Why |
|---|---|---|
| Dev (Operations manager) requests a $3,000 purchase | Priya (CFO) approves | Dev is the requester → escalated to his manager (P07) |
| US$9,000 hosting, rate 1.3425 | IT manager, then finance manager; must acknowledge `PRICE_OVER_CONTRACT` | $12,082.50 CAD crosses $10k; warnings need acknowledgement |
| Same US$9,000 sent as "$9,000 CAD" | Hold | 9,000 × 1.3425 ≠ 9,000: never converted |
| Finance dept, $300,000 | Marcus, Elise, Priya (controller + CFO) | 4 roles, 3 eligible people |
| $600,000 anywhere | Hold | Above the CFO's $500k limit |
| Vendor "Speedy Tlres Ltd", not in master | Hold | Onboard first (feature 9) |
| Clerk overrides `PO_OVER_BALANCE` | Still needs the finance manager; the clerk is barred | Override unblocks, does not make it untrue |
| Credit note −$15,000 | Routed like $15,000; note "no payment is released" | Approving a credit still needs authority |

## 11. Real-world controls beyond the brief

- **Approved vs paid amount** (`reapprovalReasons`): approvals survive an edit only if the amount owed rose
  by at most the lesser of 2% and $100, and nothing material changed (payee, currency, department,
  requester, PO, credit-note sign, a newly required role, a new exception, a now-conflicted approver).
  Paying less never needs re-approval.
- **Conflicts of interest:** whoever onboarded the vendor or changed its bank details (fake-vendor fraud), or the person a purchase is for.
- **Acknowledging exceptions:** "I never saw the price was over contract" becomes impossible.
- **Authority snapshot** (`actedAs`): an auditor a year later sees the approver's role and limit *on that day*.
- **Rejection history:** approvers see earlier rejections and "resubmitted with no change since".
- **Aging:** remind after 2 business days, escalate after 5 or within 3 days of the due date; remind before an early-payment discount lapses.
- **Budget:** note when an invoice takes a department over its annual budget.

## 12. The store: what it guarantees

- A saved plan cannot contain decisions: no forged approvals. Decisions arrive only through `saveDecision`.
- Each step is decided once: the second of two simultaneous clicks gets 409 (`UPDATE … WHERE decision = 'pending'`).
- A decision is saved only onto the plan it was made on (`planId`), for the invoice's current version.
- One plan in approval per version: you cannot re-plan to shop for a friendlier approver.
- Plans are appended, never overwritten: the full history stays for audit and `approversOf`.
- Async, behind an `ApprovalStore` interface: Postgres needs 4 queries; nothing else changes.

## 13. Design decisions, and why

| Decision | Why |
|---|---|
| Pure functions (data in, plan out) | Testable without a database, deterministic, easy to explain; the DB and `fire()` wrap around them |
| No LLM in routing or permissions | They must be deterministic and explainable; a judge can ask "why this person?" and get a rule |
| Integer cents | Floats lose cents (`0.1 + 0.2`); team rule |
| Policies as data | The Controller edits rules without a deploy; seeded from the CSV |
| Re-resolve at every click | People go on leave, return, get terminated after routing; a stored assignee would dead-end or be wrong |
| One person, one signature | Two steps by one person are one pair of eyes; the chain's point is independent review |
| Collapse only as a last resort | Better than a plan nobody can ever approve, and recorded with its reason |
| One-hop delegation | A delegate's delegate is someone the absent approver never chose |
| Conservative defaults (unknown onboarding date = new vendor, terminated requester = hold) | When unsure, add a review rather than skip one |
| Async store | Postgres in Node is async; changing signatures later would break payments |

## 14. Likely questions, with answers

**Roles and separation of duties**
- *What stops an employee approving their own invoice by calling the API directly?* `checkDecision` runs on the server for every request and returns `SELF_APPROVAL` 403. The actor comes from the session, not the body. Hiding a button is irrelevant.
- *What if the approver is on leave?* Their named delegate gets it, recorded as "on behalf of". No delegate → their manager.
- *What if the delegate requested the invoice?* Then the delegate is excluded and it escalates to the absent approver's manager.
- *Can the same person approve two steps?* No: routing escalates the second, and the gate returns `ALREADY_SIGNED`, including when their delegate signed for them.
- *Why does Elise get Facilities' department step?* She is Liam's named delegate while he is on leave. Because she then holds a step, the finance step goes to her manager Marcus.
- *Who can't release the payment?* Everyone in `approversOf(...allPlans)`: signers, the people they signed for, and approvers of earlier voided rounds.
- *Can an admin bypass approvals?* No override path exists, and P07 cannot be switched off.

**Routing**
- *What happens at exactly $10,000?* P01 ("up to") → department manager only. $10,000.01 → P02.
- *How is the CFO found when there is no `cfo` role?* The `controller_admin` with no manager.
- *What if nobody on the chain has a high enough limit?* The last step escalates to someone whose limit covers it; if nobody can, hold.
- *Hold vs blocked?* Blocked = an open blocking flag; the invoice stays in review until it is fixed. Hold = a business reason (unknown vendor, missing PO, no eligible approver) that parks it in OnHold.
- *How do split invoices work?* Validation detects them and puts the combined total on the flag; approvals routes at the combined amount. No total → it adds the finance manager rather than guess low.
- *What about USD?* Limits compare in CAD. Approvals re-checks the conversion, because an unconverted USD total would route too low.
- *Credit notes?* Routed on the absolute amount; a note says no payment is released.
- *What if a policy changes while an invoice is waiting?* The plan keeps the policy version it was routed with (known gap: in-flight invoices are not re-routed).

**Decisions and lifecycle**
- *Two approvers click at once?* The store writes only if the step is still pending; the second gets 409.
- *The invoice is edited after approval?* `reapprovalReasons` decides. Anything material, or an increase above the lesser of 2% / $100 → version bump → approvals void (`STALE_PLAN`).
- *Why must approvers acknowledge flags?* So an approval is evidence they saw the exception; the codes are stored on the step.
- *Why re-resolve the assignee at every click? Doesn't that let other people approve?* It uses the same rules as routing with today's data, so only the person those rules pick can act. It is what makes leave and terminations after routing work.
- *Why snapshot `actedAs`?* Limits and roles change; an audit needs the authority the person had when they approved.

**Engineering**
- *Why no LLM here?* Routing and permissions must be deterministic and explainable. LLMs are used only in extraction / classification / coding suggestions.
- *How do you know the tests are good?* 137 tests, including routing all 426 historical invoices and approving every routed one end to end, a 3,000-invoice random "org chaos" test, and mutation testing: bugs put back on purpose were caught (12 of 13 routing, 6 of 6 store; the one survivor is unreachable where it was removed).
- *What breaks at 100× (5,000 invoices a month)?* Nothing in routing: it is lookups over ~50 users and ~15 policies, microseconds each. Plans are stored per version, not recomputed. At scale the "waiting on" queue would be materialized and refreshed when a user's status changes, and aging runs as a daily job over pending plans.
- *How does Postgres plug in?* Implement the 4 `ApprovalStore` methods; the queries are in the comments. Proposed `approval_plans` table is in `6-approvals.md`.

## 15. Numbers to remember

| | |
|---|---|
| Amount tiers | ≤ $10k dept manager · > $10k + finance manager · > $50k + controller · > $250k + CFO |
| Approval limits | dept managers $10k · finance manager $50k · controller $250k · CFO $500k |
| Release limits (step 7) | finance manager ≤ $100k · controller > $100k |
| New-vendor window | 90 days |
| Re-approval tolerance | lesser of 2% and $100 |
| Aging | remind 2 business days · escalate 5, or within 3 days of due |
| FX tolerance / comment max | 1¢ / 2,000 characters |
| Tests | 137 (116 behaviour, 6 fixtures, 15 store) · fuzz 3,000 invoices · 5 fixtures |

## 16. What is not done yet (say so if asked)

- Not wired into the app: no database schema, no `fire()` / `authorize()` integration, no API route or screen yet (waiting on the foundation).
- The store is in-memory (`// TEMP: db`); the Postgres version needs the 4 queries and the schema owner to accept the table proposal.
- No admin policy editor UI (the schema already rejects bad rules).
- Public holidays are not in the business-day count; in-flight invoices are not re-routed when a policy changes.
- Depends on teammates for inputs: validation (`PO_OVER_BALANCE`, split totals), vendors (`conflicts`).

## 17. Glossary

| Term | Meaning |
|---|---|
| Plan | The ordered approval steps for one invoice version |
| Step | One approval by one person, for one role |
| Routing | Building the plan |
| Tier / chain | The roles an amount requires (P01–P04) |
| Escalate | Move a step up to the person's manager |
| Delegate | The person named to cover an on-leave approver (P08) |
| On behalf of | The absent approver a delegate signs for |
| `alsoCovers` | Extra roles one signature covers when nobody else is eligible |
| Excluded | May never sign this invoice (self or conflict) |
| `attention` | Exceptions an approver must acknowledge |
| `basis` | What was approved: payee, currency, amount |
| Routing amount | The CAD amount used to pick the tier |
| Hold / blocked | Parked for a business reason / stuck in review on a blocking flag |
| Voided round | Approvals from an older invoice version after a material edit |
| Separation of duties | No single person can push money out alone |

## 18. Running it

```
npx vitest run src/server/features/approvals          # all 137 tests (needs zod + vitest in package.json)
UPDATE_FIXTURES=1 npx vitest run fixtures             # regenerate fixtures after an intentional change
```
