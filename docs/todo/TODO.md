# TODO

**The full queue, not the orientation file** — [`../STATUS.md`](../STATUS.md) is that. Grep your
feature's section. Finished items move to [`tasks-completed.md`](tasks-completed.md) with a date.

**Every item names its owner** — the section owner by default; an item someone else picks up
ends with their name in brackets: `[Youssef]`. P0 items get a name before work starts.
Team: Arpan, Youssef, Andrew, Katie.

Priorities: **P0** blocks others · **P1** required feature · **P2** polish · **P3** bonus.
Bugs: [`../bugs/bugs.md`](../bugs/bugs.md).

## P0 — Foundation (everyone waits on these)

- [ ] Kickoff: settle the open decisions in `STATUS.md`; fill in owners.
- [ ] Next.js app scaffold, TypeScript strict, lint, `npm run typecheck`, test runner. [_name_]
- [ ] `core/money.ts`, `core/fx.ts` (validation's `lib/money.ts` is the candidate to promote). `core/audit.ts` done 2026-11-21. [_name_]
- [ ] Session + role switcher over seeded users. Katie's `src/server/session/` exists; still to do: read users from the `users` table and hand services an `Actor` (`src/contracts/actor.ts`). [_name_]
- [ ] `src/contracts/` for every stage + one fixture each. Approvals + shared `Flag` done 2026-11-21 (`fixtures/approvals/`). [_name_]
- [ ] Add `zod` and `vitest` to `package.json`; approvals tests already use them (`npx vitest run src/server/features/approvals`). [_name_]
- [ ] State machine gaps: credit-note path, hold at release time (bank change / duplicate found), payment as its own lifecycle. [_name_]

## 1 Intake — owner: _Arpan / Youssef / Andrew / Katie_
- [ ] P1 Upload → `documents` + draft invoice. [_name_]
- [ ] P1 Capture the requester (uploader, or who the clerk assigns) on every invoice: coding's department is 100% right with it, 82.8% without. [_name_]
- [ ] P1 Ingest AP inbox emails; classify invoice / not-invoice / no-attachment, with reason. [_name_]
- [ ] P2 Lookalike sender check against vendor domains (feeds the bonus alert). [_name_]

## 2 Extraction — owner: _Arpan / Youssef / Andrew / Katie_
- [ ] P1 PDF text + scanned image path; English and French. [_name_]
- [ ] P1 Taxes mapped to tax codes; currency; confidence per field; failure → ManualEntry. [_name_]

## 3 Coding — owner: Youssef
- [ ] P1 Persist `CodingResult` lines to `invoice_lines` (gl_account_code, department_id, coding_source, coding_reason) and rebuild `CodingIndex` from them. [Youssef]
- [ ] P1 Code / accept API route calling `codeLine` / `acceptConfident`; submit guard `codingSubmitFlags` in `fire('submit')`. [Youssef]
- [ ] P1 Review screen: suggestion + reason per line, alternatives, bulk-accept high, journal preview. [Youssef]
- [ ] P2 Optional LLM fallback for lines with no evidence, once the provider is decided; output must pass the expense-account check. [Youssef]

## 4 Validation — owner: Andrew
- [ ] P1 Mapper from extraction's contract → `ValidationInput` once it exists (needs `lineType` goods/services per line). `src/contracts/extraction.ts` is on Arpan's unmerged branch. [Andrew]
- [ ] P1 HTTP route handlers / server actions over `overrideFlag` / `resolveFlag` (services done; map `FlagActionError.status` / `Forbidden` to the response). [Andrew]
- [ ] P2 `validateBankForRelease(vendorId, bankAccountId)` for payments (7) at release time. [Andrew]
- [ ] P2 Add the incoming fixtures' expected flags to the shared `fixtures/golden/` + `npm run eval`. [Andrew]

## 5 Duplicates — owner: _Arpan / Youssef / Andrew / Katie_
- [ ] P1 Exact (sha256, vendor + normalized number), near (amount + date window), reformatted numbers. [_name_]
- [ ] P1 Already paid by card (card_transactions by vendor, amount, date). [_name_]
- [ ] P1 Dataset has a live duplicate: AP-00394 and AP-00407 (Summit Packaging, invoice `000804`, same date, lines, PO and $2,457.19) both have a scheduled payment. Duplicates must flag it before release; payments blocks on an open `block` flag once `getOpenInvoiceFlags` reads stored flags. [_name_]

## 6 Approvals — owner: Youssef
- [ ] P1 One approval store per server, not per Next bundle: keep the in-memory default store on `globalThis`, and seed it once (Katie's `fake-data/approval-seed.ts` seeds per module copy today). Do both together before the approvals screen writes decisions, or payments may read a different copy. [Youssef, Katie]
- [ ] P1 Postgres `ApprovalStore` (the 4 queries in `store.ts`) once the schema lands; schema owner to sequence the `approval_plans` proposal in `6-approvals.md`. [Youssef]
- [ ] P1 Approve / reject API route: the flow at the top of `store.ts`, in one transaction with `fire()`. [Youssef]
- [ ] P1 Approver queue screen (`waitingOn`) showing reasons, notes and exceptions to acknowledge. [Youssef]
- [ ] P1 Admin policy editor over `ApprovalPolicy` rows (the schema already rejects bad rows). [Youssef]
- [ ] P1 On invoice edit call `reapprovalReasons`; non-empty → bump `invoices.version`. [Youssef]
- [ ] P2 Daily `approvalAging` job: reminders and escalation notices. [Youssef]

## 7 Payments — owner: Youssef
## 7 Payments — owner: Katie
- [ ] P1 Schedule, release (limits, separation of duties, verified bank account), status dashboard. [Katie]
- [ ] P1 Release checks against approvals: P11 via `approversOf(...allPlans)`; amount ≤ `plan.basis.totalCents`, payee = `plan.basis.vendorId`. [Katie]

## 8 Audit + foundation — owner: Andrew
- [ ] P1 Auditor pages `app/audit` (invoice table → invoice detail → CSV export) over `src/server/features/audit` (contracts `src/contracts/audit-view.ts`, fixtures `fixtures/audit/`). Auditor-only. [_name_ (dashboard)]
- [ ] P1 Route handlers / server actions over `src/server/pipeline` (ingest, edit, code line, submit, decide), with the session's `Actor`. [_name_]
- [ ] P1 Payments on the DB: make `features/payments/deps.ts` adapters async over `payments`, `payment_flags`, `vendor_bank_accounts`, `invoice_flags`, `core/audit` + `fire()`. [Katie]
- [ ] P1 Team decisions in `docs/architecture/8-audit.md`: Controller audit access, historical `rejected` → `Voided`, schema-merge owner. [_name_]
- [ ] P2 Deploy the DB on Supabase: `db:migrate` + `db:seed` with the direct URL, `ALTER ROLE ap_app LOGIN PASSWORD …`, app uses the pooled URL. [Andrew]
- [ ] P2 Apply the `data-model.md` column additions listed in `8-audit.md` ("To apply at merge"). [Andrew]
- [ ] P3 Hash-chain `audit_events` (tamper evidence on top of the trigger + grants). [Andrew]

## 9 Vendors — owner: _Arpan / Youssef / Andrew / Katie_
- [ ] P1 Vendor list, onboard, hold; bank change request + verify by a second person. [_name_]
- [ ] P1 Supply approvals `conflicts`: who onboarded the vendor and who requested / verified its last bank change. [_name_]

## P3 — Bonus (only after 1–9 work)
- [ ] Pick one at kickoff — candidates in [`../product.md`](../product.md#out-of-scope-until-19-work). [_name_]
