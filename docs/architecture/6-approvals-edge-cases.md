# 6 — Approvals: edge cases, controls and decisions

**Owner:** Youssef · **Written:** 2026-11-21 · **Code as of:** `fb86afa`

Everything the approvals feature handles beyond the happy path, what we deliberately left out,
and the defaults the team should confirm. The design itself is in [`6-approvals.md`](6-approvals.md).

**How to read the tables.** *Where* cites `file:line`; paths are under
`src/server/features/approvals/` unless they start with `src/`. *Test* is the name of the case in
`src/server/features/approvals/__tests__/approvals.test.ts` (search for it).

---

## 1. Separation of duties

| Case | What happens | Where | Test |
|---|---|---|---|
| Requester tries to approve their own invoice | Routed to their manager (P07); a direct API call gets `SELF_APPROVAL` 403 | `route.ts:106`, `decide.ts:136` | "escalates self-approval…", "refuses the requester" |
| The person who keyed/submitted it | Same as requester | `route.ts:107` | "excludes the submitter, the PO requester and whoever overrode a flag" |
| The person who requested the PO behind it | Same as requester: they are the real requester | `route.ts:108` | same |
| Whoever overrode a flag on it | Cannot approve; `CONFLICT_OF_INTEREST` | `route.ts:112` | "whoever overrode a flag gets CONFLICT_OF_INTEREST…" |
| Whoever maintains the vendor (onboarded it, changed its bank details) | Cannot approve its invoices (`conflicts` input) | `route.ts:109` | "whoever maintains the vendor…" |
| Boss has their assistant "request" the boss's purchase | `conflicts` "is the person this purchase is for" → boss excluded | `route.ts:109` | "an assistant requesting for their boss…" |
| Delegate signs for an absent boss's **own** request | Impossible: exclusions are checked before delegation | `resolve.ts:48` | "never lets a delegate approve their absent boss's OWN request" |
| Delegate signs their own request on someone's behalf | Impossible, same reason | `resolve.ts:48` | "never lets the delegate approve their own request…" |
| One person signs two steps (directly or through a delegate) | Later step escalates at routing; `ALREADY_SIGNED` at decision | `resolve.ts:50`, `decide.ts:145` | "never lets one person hold two steps…", "treats a signature by your delegate as your signature" |
| Employee, AP clerk or auditor tries to approve | `ROLE_CANNOT_APPROVE`; never routed to them | `resolve.ts:53`, `decide.ts:144` | "refuses the auditor / AP clerk" |
| Approver releases the payment (P11) | Step 7 must call `approversOf(...allPlans)`: includes people signed *for* and approvers from voided rounds | `decide.ts:224` | "approversOf spans every round…" |
| Requester changed on the invoice after routing | The current requester is excluded too | `decide.ts:85` | "the requester changes on the invoice…" |

## 2. Delegation and leave

| Case | What happens | Where | Test |
|---|---|---|---|
| Approver on leave with a delegate (P08) | Delegate acts, recorded as *on behalf of* | `resolve.ts:86` | "routes to the delegate of an on-leave manager…" |
| On leave, no delegate | Their manager | `resolve.ts:94` | "escalates past … on-leave-without-delegate" |
| P08 switched off by an admin | Manager instead of delegate | `resolve.ts:67` | "with P08 switched off…" |
| Delegate is an employee / does not exist / is themselves | Goes to the **absent person's** manager, not the delegate's | `resolve.ts:86`, `resolve.ts:94` | "falls back to the absent approver's manager when…" |
| Delegate is also on leave | No chained delegation (one hop) → absent person's manager | `resolve.ts:86` | "does not chain delegations…" |
| Delegate already holds another step (Facilities: Liam's delegate is the finance manager) | That other step escalates | `resolve.ts:50` | "never lets one person hold two steps…" |
| Approver goes on leave **after** routing | Their delegate can act, on their behalf | `decide.ts:150` | "assignee goes on leave → their delegate acts…" |
| Absent approver comes back | It returns to them; the delegate gets `NOT_ASSIGNED` | `decide.ts:150` | "absent approver returns…" |

## 3. Org chart and directory data

| Case | What happens | Where | Test |
|---|---|---|---|
| Approver terminated | Their manager | `resolve.ts:52` | "escalates past terminated, suspended…" |
| Unknown status (e.g. `suspended`) | Treated as unavailable, never as active | `resolve.ts:52` | same |
| `manager_id` loop in the org chart | Detected; hold with "the management chain loops back…" | `resolve.ts:76` | "survives a management chain that loops" |
| Nobody above (the CFO's own purchase) | Hold with the reason; no silent self-approval | `resolve.ts:94` | "holds when the only approver above is the requester" |
| Two holders of a role (e.g. two finance managers), one is the requester | The other one signs before escalating | `resolve.ts:146` | "tries a second holder of the role before escalating" |
| `cfo` is not a user role | CFO = the `controller_admin` with no manager; also the controller's fallback | `resolve.ts:133` | "routes to … cfo:U001" |
| 4 roles but only 3 eligible people (Finance dept > $250k) | One person covers two roles (`alsoCovers`), **only** when nobody else is left | `route.ts:205` | "collapses roles only when nobody else is left" |
| Last approver's limit is below the amount | Escalates to someone whose limit covers it | `route.ts:175`, `resolve.ts:54` | "escalates past an approver whose limit is too low…" |
| Amount above every limit ($600k > CFO's $500k) | Hold | `route.ts:222` | "holds an amount nobody may approve" |
| Unknown department | Hold | `route.ts:129` | "holds a unknown department" |
| Unknown, terminated or auditor requester | Hold (terminated: reassign the requester) | `route.ts:119`–`124` | "holds a terminated requester" etc. |
| Requester works in another department | Note to approvers | `route.ts:125` | "notes cross-department charging…" |
| Lines charged to other departments | Note: only the requesting department's manager approves (P01) | `route.ts:133` | same |
| Approver reports to the requester | Note: they may find it hard to say no | `route.ts:231` | same |

## 4. Amounts and currency

| Case | What happens | Where | Test |
|---|---|---|---|
| USD total passed as CAD (never converted) | Hold: it would route too low | `route.ts:299` | "holds when the CAD amount is inconsistent: USD never converted" |
| USD with FX rate exactly 1 | Hold | `route.ts:299` | "…: USD at rate 1" |
| CAD invoice carrying an FX rate | Hold | `route.ts:299` | "…: CAD with an FX rate" |
| Sign flipped between total and CAD total | Hold | `route.ts:299` | "…: sign flipped" |
| Rounding difference in the CAD conversion | Allowed up to 1¢ | `route.ts:49` | "routes a converted USD invoice on its CAD value" |
| Fractional cents, or beyond what JavaScript stores exactly | Rejected by the contract | `src/contracts/approvals.ts:11` | "rejects amounts JavaScript cannot represent exactly" |
| Exactly $10,000.00 / $10,000.01 | P01 (up to) / P02 (over) | `route.ts:318` | "1000000 cents routes to…" |
| Credit note (negative) | Routed on its absolute value; note: no payment is released | `route.ts:85` | "routes a credit note on its absolute value…" |
| $0.00 invoice | Routed, with a note to check extraction | `route.ts:86` | "flags a $0 invoice for a second look" |
| Suspected split with combined total | Routed at the **highest** combined total, even if the flag was overridden | `route.ts:91` | "routes a suspected split at the highest combined amount…" |
| Suspected split with no usable total (missing, text, negative, fractional) | Adds a finance-manager step instead of guessing low | `route.ts:92` | "adds a finance review when a split flag has no usable combined total" |

## 5. Vendor, PO and flags

| Case | What happens | Where | Test |
|---|---|---|---|
| Vendor not in the vendor master | Hold: onboard it first (feature 9) | `route.ts:138` | "holds an unknown vendor…" |
| Vendor on hold / unknown status | Hold | `route.ts:139` | "holds a vendor that is on hold / in an unknown status" |
| Vendor pending review (P05) | Finance-manager step | `route.ts:349` | "adds a finance step for a pending_review vendor" |
| Onboarded ≤ 90 days ago, or the date is missing / in the future / unreadable | Treated as new (P05): the safe side is an extra review | `route.ts:353`–`355` | "treats a vendor with … as new" |
| Legal vendor (P06), any spacing or case | Finance step, merged with the amount step (one step, both reasons) | `route.ts:360` | "adds a finance step for a Legal vendor…" |
| Vendor requires a PO and there is none, or it is blank (P13) | Hold | `route.ts:365` | "holds when the vendor requires a PO…" |
| PO over balance (P12), open **or overridden** | Finance step; a clerk's override does not remove the review | `route.ts:63`, `route.ts:361` | "PO over balance adds a finance step…" |
| Open blocking flag (duplicate etc.) | `blocked`: stays in review | `route.ts:73` | "blocks while a block flag is open…" |
| Blocking flag overridden without recording who | Still blocked: an anonymous override cannot be honoured | `route.ts:75` | same |
| Resolved flags | Ignored | `route.ts:63` | same |
| Long or multi-line vendor text copied from the invoice | Clipped to one short line in messages (it is data, not instructions) | `directory.ts:90` | "holds an unknown vendor, and keeps invoice text short" |

## 6. Policy configuration (admin mistakes)

| Case | What happens | Where | Test |
|---|---|---|---|
| Approval chain keyed on something other than an amount | Rejected on save (it could replace the amount tiers) | `src/contracts/approvals.ts:81` | "rejects a chain keyed on something other than an amount…" |
| Release rule filed as an approval rule | Rejected on save | `src/contracts/approvals.ts:84` | "rejects a release rule filed as an approval rule" |
| A new policy row the seed does not understand | Seed fails loudly, naming the row | `policies-from-csv.ts:109` | "refuses to seed a policy row it does not understand" |
| Two amount chains with the same priority | The longer (stricter) chain wins | `route.ts:330` | — |
| Amount ranges with a gap | Hold: "No active amount policy covers $X" | `route.ts:145` | — |
| Admin deactivates P07 (self-approval) | Still enforced: the brief requires it | `resolve.ts:66` | — |

## 7. The decision API (what judges will try)

| Request | Response | Where | Test |
|---|---|---|---|
| `action` not exactly `approve`/`reject`, no body, comment not text or > 2,000 chars, `acknowledgedFlags` not a list | 400 `INVALID_REQUEST` | `decide.ts:104`–`112` | "rejects a malformed request: …" |
| Stored plan corrupt (duplicate step numbers, invalid fields) | 409 `CORRUPT_PLAN` | `decide.ts:116` | "refuses a corrupt stored plan" |
| Plan from another invoice | 409 `WRONG_INVOICE` | `decide.ts:120` | "refuses to act on another invoice's plan" |
| Invoice edited since routing | 409 `STALE_PLAN` | `decide.ts:122` | "…an edited invoice (new version)" |
| Invoice no longer pending approval | 409 `NOT_PENDING` | `decide.ts:124` | "…an invoice no longer pending" |
| Invoice held or blocked | 409 `NOT_ROUTED` | `decide.ts:125` | "refuses to act on a held invoice" |
| Everything already decided, or rejected | 409 `ALREADY_DECIDED` | `decide.ts:79` | "walks the happy path…" |
| Unknown / on-leave / terminated user | 403 `UNKNOWN_USER` / `USER_INACTIVE` | `decide.ts:132` | "refuses the unknown user / on-leave original approver" |
| Not their step right now | 403 `NOT_ASSIGNED`, names who it is with | `decide.ts:154` | "refuses the step-2 approver jumping the queue" |
| Reject with no reason | 400 `COMMENT_REQUIRED` | `decide.ts:158` | "requires a reason to reject…" |
| Approve without acknowledging the exceptions | 409 `FLAGS_NOT_ACKNOWLEDGED`, lists them with numbers | `decide.ts:164` | "refuses an approval that does not acknowledge them…" |
| Vendor put on hold since routing | 409 `VENDOR_NOT_PAYABLE` (reject still allowed) | `decide.ts:175` | "vendor put on hold → cannot approve, can still reject" |
| Finished chain lacks authority for the amount | 403 `INSUFFICIENT_AUTHORITY` | `decide.ts:180` | — (defence in depth) |
| Nobody can sign the step any more | 409 `NO_ELIGIBLE_APPROVER`: resubmit to re-route | `decide.ts:152` | "nobody left → a clear 409…" |
| Double click / two approvers at once | `applyDecision` throws on a non-pending step; the DB write must be `WHERE decision = 'pending'` | `decide.ts:202` | "walks the happy path…" (double click) |
| Route handler checks one thing, applies another | Impossible: `applyDecision` takes the actor and request from the check | `decide.ts:198` | — |

## 8. Changes after routing (self-healing instead of dead ends)

At every decision the current step is re-resolved against **today's** directory
(`resolve.ts:185`, called at `decide.ts:150`), so the plan never points at someone who can no
longer act.

| Change | Result | Test |
|---|---|---|
| Assignee goes on leave | Their delegate acts on their behalf | "assignee goes on leave…" |
| Assignee terminated | Their manager acts | "assignee is terminated…" |
| Absent approver returns | Back to them | "absent approver returns…" |
| Assignee's limit lowered below the amount | Their manager acts | "assignee's limit drops below the amount…" |
| Everyone up the chain gone | Clear 409, resubmit | "nobody left…" |
| Invoice edited | `reapprovalReasons` decides whether approvals survive (section 9) | "edits after approval…" |

## 9. Real-world AP controls beyond the brief

| Real-world problem | What step 6 does | Where | Test |
|---|---|---|---|
| **Approved $3,000, paid $3,900** after a "corrected" invoice or added freight | `reapprovalReasons` voids approvals when the amount owed rises more than the lesser of 2% / $100, or the payee, currency, department, requester or PO changes, it flips between invoice and credit note, it now needs another role, a new exception appears, an approver is no longer independent, or it would no longer route. Paying **less** never needs re-approval. `basis` tells step 7 the most it may pay, and to whom. | `lifecycle.ts:25`, `route.ts:257` | "edits after approval…" (11 cases) |
| **Fake vendor**: an employee creates a vendor, then approves its invoices | Vendor-master maintainers passed as `conflicts` cannot approve | `route.ts:109` | "whoever maintains the vendor…" |
| **"I never saw the price was over contract"** | Every unresolved warning and overridden flag is in `attention`; approval requires acknowledging each code; stored on the step | `route.ts:277`, `decide.ts:164` | "approvers must acknowledge exceptions" (4 cases) |
| **CRA asks a year later** whether the approver had authority then | `actedAs` snapshots name, role and limit at the moment of the decision | `decide.ts:156` | "snapshots the approver's name, role and limit…" |
| **Rejected, then resubmitted unchanged** hoping for a different answer | Approvers see who rejected it, when and why, and "resubmitted with no change since" | `route.ts:238` | "tells approvers about earlier rejections…" |
| **Approvals sit** until the due date or a 2/10-net-30 discount passes (72 of 426 historical invoices were first approved after their due date) | `approvalAging`: business days waiting; remind after 2, escalate (notify the manager) after 5 or within 3 days of the due date; remind before a discount lapses. Notifies only, never reassigns. | `lifecycle.ts:129` | "aging: …" (5 cases) |
| **Department blows its annual budget** | Note with the % to one decimal (never "100%" when over); an admin can add a `department_over_budget` rule to require the finance manager | `route.ts:288` | "budget" (2 cases) |

## 10. Bugs found in earlier drafts, now fixed

1. A delegate could approve their absent boss's own request: leave was checked before exclusions.
2. An unconverted USD amount routed too low (a $9,000 USD invoice skipped the finance step).
3. Leave or termination after routing left an invoice nobody could approve.
4. A clerk overriding `PO_OVER_BALANCE` removed the P12 finance review.
5. Finance-department invoices over $250k could never be approved (4 roles, 3 people).
6. A second holder of a role was skipped in favour of escalating.
7. An unusable delegate escalated to the delegate's manager, and delegations could chain.
8. Unknown statuses such as `suspended` were treated as able to approve.
9. Approver limits were only checked for the whole chain, never used to pick the approver.
10. `applyDecision` could record a different actor or action than `checkDecision` approved.
11. The request body was trusted (judges send raw JSON).
12. The first prototype (Python) did split detection inside approvals, which belongs to validation, and hard-coded the dataset date.

## 11. Considered and deliberately left out

| Idea | Why not (yet) |
|---|---|
| Auto-approve recurring contract invoices ("touchless") | Removes a control: a team decision, not something to add quietly |
| Admin manually reassigns a step | Classic way around approval rules; self-healing already covers leave and termination |
| Detect reciprocal approvals (A approves B's, B approves A's) and rubber-stamping | Analytics across many invoices, not routing; fits the spend-analytics bonus |
| Each charged department's manager approves their lines | Not in policy (P01 says the requesting department); we show a note instead |
| Exempt credit notes from "PO required" (P13) | Kept the policy literal (hold); credit notes from PO vendors usually reference the PO |
| Scheduled leave (future `status_since`) | The data model holds current status only |
| Public holidays in business days | Small; documented gap |
| "Request more info" without rejecting | A UI / comment feature, not a state change |
| Approval expiry (approved long ago, still unpaid) | A release-time check: feature 7 |
| Structured rejection reason codes | Useful for analytics; free text for now |
| Approver whose role or limit changed recently (privilege escalation) | Needs a history of user changes (features 8/9) |
| Look up bank-change makers ourselves | Feature 9 owns those tables; it passes them in `conflicts` |

## 12. Defaults to confirm at kickoff

| Setting | Default | Where |
|---|---|---|
| Two roles on one person when nobody else is eligible | On (instead of a dead-end hold) | `route.ts:205` |
| Delegation depth | One hop | `resolve.ts:86` |
| New-vendor window (P05) | 90 days, editable per policy | `policies-from-csv.ts:19` |
| Terminated requester | Hold (reassign) | `route.ts:122` |
| Overridden flags | Still drive routing; the overrider cannot approve | `route.ts:63`, `route.ts:112` |
| Re-approval tolerance | Lesser of 2% and $100 | `lifecycle.ts:23` |
| Aging | Remind after 2 business days, escalate after 5 or within 3 days of the due date | `lifecycle.ts:135` |
| FX rounding tolerance | 1¢ | `route.ts:49` |
| Max comment length | 2,000 characters | `decide.ts:20` |

## 13. What teammates must supply

| Who | What |
|---|---|
| Validation (4) | `PO_OVER_BALANCE`; `SPLIT_INVOICE_SUSPECTED` with `evidence.combinedCadCents`; warnings whose messages carry the numbers |
| Duplicates (5) | Blocking flags (`DUPLICATE_SUSPECTED`, already paid by card) |
| Vendors (9) | `conflicts`: who onboarded the vendor and who requested / verified its last bank change |
| Intake | `submittedBy`; optionally "this purchase is for" as a conflict |
| Foundation | `authorize()` calls `checkDecision`; `fire()` events `submit` / `hold` / `stepApproved` / `stepRejected`; conditional step write; bump `invoices.version` when `reapprovalReasons` is non-empty; daily `approvalAging` job |
| Payments (7) | P11 via `approversOf(...allPlans)`; pay no more than `basis.totalCents`, and only to `basis.vendorId` |
| Seed | `policiesFromCsv()`; department `annual_budget_cad` |

## 14. How this was verified

- **116 tests**, run on Zod 3.25 and 4.6. Refusals are table-driven, so the Q&A answer to "how are roles enforced?" is one table.
- **History replay**: every routed historical invoice is approved end to end by the people it waits on; nobody signs twice; the requester never signs.
- **Org-chaos test**: 3,000 random invoices with random leave, terminations, delegates, manager loops, conflicts and warnings. Invariants: no crash, plan always valid, no excluded person assigned, nobody twice, everyone assigned active, the chain always carries the amount, and the walk always finishes.
- **Mutation testing**: 13 bugs re-introduced on purpose; 12 made tests fail. The survivor (marking the on-behalf-of person as taken *during routing*) is unreachable there and is covered at decision time.
- Run: `npx vitest run src/server/features/approvals` (needs `zod` and `vitest` in `package.json`).
