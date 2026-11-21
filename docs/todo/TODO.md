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
- [ ] `src/contracts/` for every stage + one fixture each. [_name_]
- [ ] State machine gaps: credit-note path, hold at release time (bank change / duplicate found), payment as its own lifecycle. [_name_]

## 1 Intake — owner: _Arpan / Youssef / Andrew / Katie_
- [ ] P1 Upload → `documents` + draft invoice. [_name_]
- [ ] P1 Ingest AP inbox emails; classify invoice / not-invoice / no-attachment, with reason. [_name_]
- [ ] P2 Lookalike sender check against vendor domains (feeds the bonus alert). [_name_]

## 2 Extraction — owner: _Arpan / Youssef / Andrew / Katie_
- [ ] P1 PDF text + scanned image path; English and French. [_name_]
- [ ] P1 Taxes mapped to tax codes; currency; confidence per field; failure → ManualEntry. [_name_]

## 3 Coding — owner: _Arpan / Youssef / Andrew / Katie_
- [ ] P1 Vendor → (account, dept) history table from historical invoices; suggestion with reason. [_name_]
- [ ] P1 Fallback for new vendors (vendor default account, then description similarity). [_name_]

## 4 Validation — owner: _Arpan / Youssef / Andrew / Katie_
- [ ] P1 Vendor master, contract caps / end dates / spend limits, PO match, tax vs province, arithmetic. [_name_]
- [ ] P1 Split-invoice check (same vendor, short window, sum crosses a threshold). [_name_]

## 5 Duplicates — owner: _Arpan / Youssef / Andrew / Katie_
- [ ] P1 Exact (sha256, vendor + normalized number), near (amount + date window), reformatted numbers. [_name_]
- [ ] P1 Already paid by card (card_transactions by vendor, amount, date). [_name_]

## 6 Approvals — owner: _Arpan / Youssef / Andrew / Katie_
- [ ] P1 Policy engine from `approval_policies`; plan stored per invoice version. [_name_]
- [ ] P1 Self-approval escalation, delegation, absent approver; admin policy editor. [_name_]

## 7 Payments — owner: _Arpan / Youssef / Andrew / Katie_
- [ ] P1 Schedule, release (limits, separation of duties, verified bank account), status dashboard. [_name_]

## 8 Audit — owner: _Arpan / Youssef / Andrew / Katie_
- [ ] P1 Audit view per payment: PDF → extraction → coding → approvals → release; auditor export (CSV). [_name_]

## 9 Vendors — owner: _Arpan / Youssef / Andrew / Katie_
- [ ] P1 Vendor list, onboard, hold; bank change request + verify by a second person. [_name_]

## P3 — Bonus (only after 1–9 work)
- [ ] Pick one at kickoff — candidates in [`../product.md`](../product.md#out-of-scope-until-19-work). [_name_]
