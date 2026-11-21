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
| BUG-Andrew-01 | High | Andrew | 2026-11-21 | Empty string in an extracted field crashed validation |
| BUG-Andrew-02 | High | Andrew | 2026-11-21 | Impossible dates (2026-02-30) rolled over and raised false date flags |
| BUG-Andrew-03 | High | Andrew | 2026-11-21 | Unmapped tax line produced a false blocking TAX_MISSING |
| BUG-Katie-01 | High | Katie | 2026-11-21 | Release said "No approval record was found" in the app while tests passed |
| BUG-Katie-02 | Medium | Katie | 2026-11-21 | `import "server-only"` made `npm run check` fail |

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
**Fix.** `checkDecision` re-resolves the current step against today's directory (`decide.ts:150` → `resolve.ts:186`, `fb86afa`).
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

### BUG-Andrew-01
**Empty string in an extracted field crashed validation** · High · FIXED · found 2026-11-21 by a review session (Andrew's)

**Symptom.** `validateInvoice({ …, invoiceNumber: "" })` threw a ZodError instead of flagging the field missing.
**Cause.** Optional strings were `z.string().trim().min(1).nullable()`: `""` failed `min(1)`.
**Fix.** `src/contracts/validation.ts`: blank or whitespace → `null` for every optional string, date, tax code and remit-to field (`blankToNull`). Uncommitted on `bb44a67`.
**Why it happened.** Treated "missing" as only `null`; extractors emit `""` for unreadable fields.
**Rule added.** docs/rules/contracts.md.

### BUG-Andrew-02
**Impossible dates rolled over and raised false date flags** · High · FIXED · found 2026-11-21 by a review session

**Symptom.** Invoice date `2026-02-30` was read as March 2: false `DATE_TOO_OLD` (223 days) and `TERMS_MISMATCH` (252 days).
**Cause.** Dates were checked by regex only; `Date.UTC(2026, 1, 30)` silently normalises to March 2.
**Fix.** `lib/dates.ts` `isRealDate()` and `toUtcDay` refuses impossible dates; `derive.ts` `setAsideInvalidDates()` removes them before any rule runs (received date falls back to today); new `INVALID_DATE` (block) flag. Uncommitted on `bb44a67`.
**Why it happened.** Trusted the YYYY-MM-DD shape as a real date.
**Rule added.** docs/rules/contracts.md.

### BUG-Andrew-03
**Unmapped tax line produced a false blocking TAX_MISSING** · High · FIXED · found 2026-11-21 by a review session

**Symptom.** A tax line with `code: null` ("TVH (13 %)") gave `TAX_CODE_UNKNOWN` and also `TAX_MISSING: No tax charged…`, which is false.
**Cause.** The unmapped line was dropped from the charged set, so the rule saw no tax at all.
**Fix.** `tax-expectations.ts` `inferTaxCode()`: code inferred only when label family AND printed rate match exactly one `tax_codes` row; `rules/tax.ts`: while any line stays unmapped, nothing is reported missing (wrong mapped codes still are). Uncommitted on `bb44a67`.
**Why it happened.** "Not mapped" was treated as "not charged".
**Rule added.** docs/rules/money-and-tax.md.

### BUG-Katie-01
**Release said "No approval record was found" in the app while tests passed** · High · FIXED · found 2026-11-21 by Katie

**Symptom.** On `npm run dev`, every release on `/payments` was refused with "No approval record was found"; `flow.test.ts` passed.
**Cause.** Next.js loads server code more than once (one module copy per server bundle), so each copy of `features/approvals` has its own default store. The seed flag sat on `globalThis`, so only the first copy got the approval history.
**Fix.** The seed is memoized per module copy, not on `globalThis` (`src/server/features/payments/fake-data/approval-seed.ts:86`, `0fa1e56`).
**Why it happened.** Assumed one module instance per process, which is true under vitest and tsx but not under Next.
**Rule added.** docs/rules/backend.md.

### BUG-Katie-02
**`import "server-only"` made `npm run check` fail** · Medium · FIXED · found 2026-11-21 by Katie

**Symptom.** `npm run check:imports` threw on `src/server/session/*.ts`.
**Cause.** `scripts/check-imports.ts` imports every module under `src/` with tsx; `server-only` throws outside Next's server build.
**Fix.** Removed the import from `src/server/session/` (`d87deef`). The browser still never reaches it: only server components and server actions import it.
**Why it happened.** `server-only` is a Next-only guard; our checks run outside Next.
**Rule added.** docs/rules/backend.md.
