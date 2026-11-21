# Completed tasks

Finished work moved out of [`TODO.md`](TODO.md). Append-only, newest first. One entry per item:
date, owner, what landed, and anything learned that the next person should know.

Format:

```
- [x] **<item>** — 2026-11-21 · <Arpan/Youssef/Andrew/Katie> · <commit sha>. <one or two lines: what works, what is stubbed, what surprised you.>
```

---

- [x] **Split-invoice check** — 2026-11-21 · Andrew · uncommitted. Same vendor, ≤ 3 days, each ≤ a policy threshold, combined over it → `SPLIT_INVOICE_SUSPECTED` with `evidence.combinedCadCents`. Window measured on history: 7 days flags routine freight billing; duplicates (same/near-same number) never count.
- [x] **Validation checks: vendor master, contract caps / end dates / spend limits, PO match, tax vs province, arithmetic** — 2026-11-21 · Andrew · uncommitted. Pure engine + ~55 flag codes, 264 tests, 56/56 incoming invoices match hand-written expectations. Stubbed: CSV context instead of DB, flags not persisted. Surprise: lookalike vendor records can be onboarded *before* the real one — use invoice history, not dates.
- [x] **Docs and agent setup** — 2026-11-20 · Arpan. `CLAUDE.md`, `product.md`, architecture overview, data model, roles, rules, STATUS, TODO, bugs, `/wrap-up`, `/commit-msg`.
