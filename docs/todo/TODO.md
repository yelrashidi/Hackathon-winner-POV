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
- [ ] Docker Postgres for local; `.env.example`; `npm run db:reset` (migrate + seed). [_name_]
- [ ] Schema from [`data-model.md`](../architecture/data-model.md); seed every CSV in `brim_ap_dataset/brim_ap_dataset/data/` + `inbox/emails.json`. [_name_]
- [ ] `core/fire.ts` — transitions from `docs/explainers/brim-ap-diagrams.md`, guards, audit in the same transaction. [_name_]
- [ ] `core/authorize.ts` + table-driven permission test ([`roles-and-permissions.md`](../architecture/roles-and-permissions.md)). [_name_]
- [ ] `core/audit.ts`, `core/money.ts`, `core/fx.ts`. [_name_]
- [ ] Session + role switcher over seeded users. [_name_]
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

## 4 Validation — owner: _Arpan / Youssef / Andrew / Katie_
- [ ] P1 Vendor master, contract caps / end dates / spend limits, PO match, tax vs province, arithmetic. [_name_]
- [ ] P1 Split-invoice check (same vendor, short window, sum crosses a threshold). [_name_]
- [ ] P1 Emit `PO_OVER_BALANCE` (P12) and `SPLIT_INVOICE_SUSPECTED` with `evidence.combinedCadCents`; approvals routes on both. [_name_]
## 4 Validation — owner: Andrew
- [ ] P1 DB loader for `ValidationContext` (replaces `dataset/load-context.ts`; per-vendor rows only). [Andrew]
- [ ] P1 Persist flags to `invoice_flags` (diff by `flagKey`, keep resolutions) + `hasBlocking` as the `submit` guard in `fire()`. Needs `source`/`fingerprint` columns — propose to schema owner. [Andrew]
- [ ] P1 Override / resolve endpoint: `authorize('flag.override')` + note + audit in one transaction. [Andrew]
- [ ] P1 Mapper from extraction's contract → `ValidationInput` once it exists (needs `lineType` goods/services per line). [Andrew]
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

## 8 Audit — owner: _Arpan / Youssef / Andrew / Katie_
- [ ] P1 Audit view per payment: PDF → extraction → coding → approvals → release; auditor export (CSV). [_name_]

## 9 Vendors — owner: _Arpan / Youssef / Andrew / Katie_
- [ ] P1 Vendor list, onboard, hold; bank change request + verify by a second person. [_name_]
- [ ] P1 Supply approvals `conflicts`: who onboarded the vendor and who requested / verified its last bank change. [_name_]

## P3 — Bonus (only after 1–9 work)
- [ ] Pick one at kickoff — candidates in [`../product.md`](../product.md#out-of-scope-until-19-work). [_name_]
