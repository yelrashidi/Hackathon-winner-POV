# Completed tasks

Finished work moved out of [`TODO.md`](TODO.md). Append-only, newest first. One entry per item:
date, owner, what landed, and anything learned that the next person should know.

Format:

```
- [x] **<item>** — 2026-11-21 · <Arpan/Youssef/Andrew/Katie> · <commit sha>. <one or two lines: what works, what is stubbed, what surprised you.>
```

---

- [x] **PR #11 review: Gmail cursor, credit signs and missing line values** — 2026-11-21 · Arpan · review fixes on `b655a97`. BUG-Arpan-02/03/04 fixed with regression tests; 644 tests and batch/history validation pass. Persistence remains step 3.
- [x] **Real intake/extraction contract fixtures** — 2026-11-21 · Arpan · review fixes on `b655a97`. Three real document reads (invoice, scan, credit note), two safe fallbacks, eight message/classification pairs; `npm run fixtures:intake` replays raw replies offline. Andrew's validation mapper and Youssef's `lineType` consumer now have checked fixtures. French parsing is separately unit-tested; French email subjects do not imply French PDF bodies.

- [x] **Extraction: PDF text + scanned image path; English and French; taxes mapped to tax codes; currency; confidence per field** — 2026-11-21 · Arpan · uncommitted. One read per document → `DocumentReading` / `ExtractedDocument`: local text layer (`unpdf`) → document-type rules → one Claude read (text, or the image for scans) → normalizer turns printed amounts into cents. Stubbed: not persisted; failure → `ManualEntry` waits for step 3. Surprise: "Payment terms: Due on receipt" contains "receipt"; a CREDIT NOTE can label its number "Invoice Number".
- [x] **Ingest AP inbox emails; classify invoice / not-invoice / no-attachment, with reason** — 2026-11-21 · Arpan · uncommitted. Gmail connector + dataset adapter → `InboxMessage`; only documents read as invoices or credit notes become bills (BUG-Arpan-01); nothing dropped. Stubbed: nothing persisted (step 3 in `TODO.md`).
- [x] **Schedule, release (limits, separation of duties, verified bank account), status dashboard** — 2026-11-21 · Katie · `b69ce5d`. In-memory payments service + `/payments` dashboard on the real code; simulated EFT with 9 failure reasons, urgency flags, two-person bank change. Stubbed: everything from other features behind `deps.ts` (`docs/payment-assumptions.md`). Surprise: the dataset already has a duplicate scheduled twice (AP-00394 / AP-00407).
- [x] **Release checks against approvals** — 2026-11-21 · Katie · `b69ce5d`. P11 via `approversOf(...getApprovalPlans())`; payee and amount against `getCurrentApprovalPlan().basis`. A TEMP seed loads `approvals.csv` into Youssef's store until his flow fills it.
- [x] **Coding: vendor → (account, dept) history with reasons** — 2026-11-21 · Youssef · `5d3ec67`. `CodingIndex` (by vendor, invoice number, word) + evidence ladder; chronological backtest 99.6%, high confidence 455/455.
- [x] **Coding: fallback for new vendors** — 2026-11-21 · Youssef · `5d3ec67`. Vendor-master default, category, same product elsewhere, word vote (never high).
- [x] **Approval plan storage API** — 2026-11-21 · Youssef · `a896a64`. `saveApprovalPlan` / `getApprovalPlans` / `getCurrentApprovalPlan` / `saveDecision` behind an `ApprovalStore` interface; in-memory for now (`// TEMP: db`), Postgres needs only the 4 store queries. Asked for by Katie (payments).
- [x] **Approvals policy engine from `approval_policies` (P01–P13)** — 2026-11-21 · Youssef · `fb86afa`. Pure `planApprovals`; plans carry `invoiceVersion` but are not persisted yet (no schema). Every edge case: [`6-approvals-edge-cases.md`](../architecture/6-approvals-edge-cases.md).
- [x] **Self-approval escalation, delegation, absent approver** — 2026-11-21 · Youssef · `fb86afa`. Exclusions are checked before delegation, delegation is one hop, and the step is re-resolved at decision time, so leave and terminations after routing self-heal. Admin policy editor still open.
- [x] **Split-invoice check** — 2026-11-21 · Andrew · uncommitted. Same vendor, ≤ 3 days, each ≤ a policy threshold, combined over it → `SPLIT_INVOICE_SUSPECTED` with `evidence.combinedCadCents`. Window measured on history: 7 days flags routine freight billing; duplicates (same/near-same number) never count.
- [x] **Validation checks: vendor master, contract caps / end dates / spend limits, PO match, tax vs province, arithmetic** — 2026-11-21 · Andrew · uncommitted. Pure engine + ~55 flag codes, 264 tests, 56/56 incoming invoices match hand-written expectations. Stubbed: CSV context instead of DB, flags not persisted. Surprise: lookalike vendor records can be onboarded *before* the real one — use invoice history, not dates.
- [x] **Docs and agent setup** — 2026-11-20 · Arpan. `CLAUDE.md`, `product.md`, architecture overview, data model, roles, rules, STATUS, TODO, bugs, `/wrap-up`, `/commit-msg`.
