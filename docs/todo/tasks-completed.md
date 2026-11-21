# Completed tasks

Finished work moved out of [`TODO.md`](TODO.md). Append-only, newest first. One entry per item:
date, owner, what landed, and anything learned that the next person should know.

Format:

```
- [x] **<item>** — 2026-11-21 · <Arpan/Youssef/Andrew/Katie> · <commit sha>. <one or two lines: what works, what is stubbed, what surprised you.>
```

---

- [x] **Extraction: PDF text + scanned image path; English and French; taxes mapped to tax codes; currency; confidence per field** — 2026-11-21 · Arpan · uncommitted. One read per document → `DocumentReading` / `ExtractedDocument`: local text layer (`unpdf`) → document-type rules → one Claude read (text, or the image for scans) → normalizer turns printed amounts into cents. Stubbed: not persisted; failure → `ManualEntry` waits for step 3. Surprise: "Payment terms: Due on receipt" contains "receipt"; a CREDIT NOTE can label its number "Invoice Number".
- [x] **Ingest AP inbox emails; classify invoice / not-invoice / no-attachment, with reason** — 2026-11-21 · Arpan · uncommitted. Gmail connector + dataset adapter → `InboxMessage`; only documents read as invoices or credit notes become bills (BUG-Arpan-01); nothing dropped. Stubbed: nothing persisted (step 3 in `TODO.md`).
- [x] **Split-invoice check** — 2026-11-21 · Andrew · uncommitted. Same vendor, ≤ 3 days, each ≤ a policy threshold, combined over it → `SPLIT_INVOICE_SUSPECTED` with `evidence.combinedCadCents`. Window measured on history: 7 days flags routine freight billing; duplicates (same/near-same number) never count.
- [x] **Validation checks: vendor master, contract caps / end dates / spend limits, PO match, tax vs province, arithmetic** — 2026-11-21 · Andrew · uncommitted. Pure engine + ~55 flag codes, 264 tests, 56/56 incoming invoices match hand-written expectations. Stubbed: CSV context instead of DB, flags not persisted. Surprise: lookalike vendor records can be onboarded *before* the real one — use invoice history, not dates.
- [x] **Docs and agent setup** — 2026-11-20 · Arpan. `CLAUDE.md`, `product.md`, architecture overview, data model, roles, rules, STATUS, TODO, bugs, `/wrap-up`, `/commit-msg`.
