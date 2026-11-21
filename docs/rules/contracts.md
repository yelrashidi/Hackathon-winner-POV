---
description: Stage hand-off contracts and fixtures — the only thing that crosses feature boundaries
paths:
  - "src/contracts/**"
  - "fixtures/**"
---

# Contracts between stages

- **`src/contracts/` is the hand-off.** Each stage's input and output is a Zod schema with its
  type inferred (`z.infer`). Never hand-write a duplicate TypeScript type for the same shape.
- **Changing a contract breaks a teammate.** Adding an optional field is safe. Renaming, removing,
  or making a field required means: update the fixtures, run `npm run typecheck` across the repo,
  put `contract:` in the PR title, and tell the downstream owner (names in `STATUS.md`).
- **Fixtures are frozen stage outputs**, `fixtures/<stage>/<case>.json`, each valid against its
  schema (a test parses all of them). Downstream builds against fixtures, so it never waits for upstream.
- **When your stage works for real, regenerate its fixtures from real runs** and re-run the
  downstream tests. A fixture nobody regenerates becomes a lie both sides test green against.
- **Flags have one shape for everyone:** `{ code, severity, message, evidence, relatedInvoiceId?, relatedCardTxnId? }`.
  Validation and duplicates both emit it; the UI renders it without knowing which feature raised it.
- **The golden set** (`fixtures/golden/`) is real incoming invoices with the flags and route we
  expect. `npm run eval` runs the pipeline over it and diffs. Add a case for every mess pattern you handle.
- **Blank means missing, and a date must be a real day.** Producers emit `""` for unreadable fields: contracts turn it into `null`, never reject it (BUG-Andrew-01). `Date.UTC` silently rolls `2026-02-30` to March 2 — check the calendar day, then flag it, don't compute with it (BUG-Andrew-02).
