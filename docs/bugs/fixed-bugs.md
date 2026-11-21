# Fixed bugs

Kept for the Q&A and so the same trap is not hit twice. If a fix taught a rule, the rule line in
`docs/rules/` cites this id.

| ID | Severity | Fixed by | Fixed | Summary |
|---|---|---|---|---|
| BUG-Youssef-01 | High | Youssef | 2026-11-21 | A delegate could approve their absent boss's own request |
| BUG-Youssef-02 | High | Youssef | 2026-11-21 | An unconverted USD total routed to too few approvers |
| BUG-Youssef-03 | Medium | Youssef | 2026-11-21 | Leave or termination after routing left nobody able to approve |
| BUG-Youssef-04 | Medium | Youssef | 2026-11-21 | Overriding `PO_OVER_BALANCE` removed the P12 finance review |
| BUG-Youssef-05 | Medium | Youssef | 2026-11-21 | `applyDecision` could record a different actor or action than was checked |

---

### BUG-Youssef-01
**A delegate could approve their absent boss's own request** · High · FIXED · found 2026-11-21 by Youssef

**Symptom.** Liam (on leave, delegate Elise) requests a Facilities invoice; it routes to Elise "on behalf of Liam": Liam approving Liam.
**Fix.** Exclusions are checked before leave, so an excluded person is escalated, never delegated (`src/server/features/approvals/resolve.ts:48`, `fb86afa`).
**Why it happened.** The resolver followed the delegation first and only then asked whether the person may sign.
**Rule added.** `docs/rules/backend.md`.

### BUG-Youssef-02
**An unconverted USD total routed to too few approvers** · High · FIXED · found 2026-11-21 by Youssef

**Symptom.** A US$9,000 invoice passed in as $9,000 CAD (really $12,330) skipped the finance-manager step.
**Fix.** Routing re-checks `total × fx_rate = total_cad` (±1¢), rate 1 for CAD only; otherwise hold (`route.ts:299`, `fb86afa`).
**Why it happened.** Approvals trusted `totalCadCents` blindly; nothing upstream guarantees the conversion happened.
**Rule added.** `docs/rules/money-and-tax.md`.

### BUG-Youssef-03
**Leave or termination after routing left nobody able to approve** · Medium · FIXED · found 2026-11-21 by Youssef

**Symptom.** Routed to Dev; Dev is then terminated: every approve attempt is `NOT_ASSIGNED`, forever.
**Fix.** `checkDecision` re-resolves the current step against today's directory (`decide.ts:150` → `resolve.ts:185`, `fb86afa`).
**Why it happened.** The decision trusted the assignee stored at routing time.
**Rule added.** `docs/rules/backend.md`.

### BUG-Youssef-04
**Overriding `PO_OVER_BALANCE` removed the P12 finance review** · Medium · FIXED · found 2026-11-21 by Youssef

**Symptom.** A clerk overrides the over-balance flag; the invoice routes without the finance manager.
**Fix.** Overridden flags still drive routing (only `resolved` ones are ignored), and the overrider cannot approve (`route.ts:63`, `route.ts:112`, `fb86afa`).
**Why it happened.** "Overridden" was treated as "no longer true"; an override only unblocks.
**Rule added.** `docs/rules/backend.md`.

### BUG-Youssef-05
**`applyDecision` could record a different actor or action than was checked** · Medium · FIXED · found 2026-11-21 by Youssef

**Symptom.** A handler could check `reject` for one user and then apply `approve` for another; nothing stopped it.
**Fix.** `applyDecision` takes the actor and request from the check result only (`decide.ts:200`, `fb86afa`).
**Why it happened.** Actor and action were separate arguments to the write.
**Rule added.** `docs/rules/backend.md`.

Seven smaller ones fixed in the same unit are listed in [`6-approvals-edge-cases.md`](../architecture/6-approvals-edge-cases.md) §10.

<!-- Entry format: the open entry from bugs.md, plus
**Fix.** What changed (`file:line`, commit sha).
**Why it happened.** The real cause, in one or two lines.
**Rule added.** docs/rules/<file>.md, or "none — one-off".
-->
