# Open bugs

Resolved ones move to [`fixed-bugs.md`](fixed-bugs.md) with the fix and the reason.

**Ids are `BUG-<Name>-<nn>`**, named after whoever files it: `BUG-Arpan-nn`, `BUG-Youssef-nn`, `BUG-Andrew-nn`, `BUG-Katie-nn`. Add the owner of the affected feature in the table.
Grep both files for your own highest id before filing; ids are never reused.

| ID | Severity | Feature (owner) | Summary |
|---|---|---|---|
| BUG-Arpan-08 | Low | tests (shared) | `npm test` workers crash ("Worker exited unexpectedly") at the default worker count; `--maxWorkers=2` passes |

---

### BUG-Arpan-08
**`npm test` workers crash under load** · Low · OPEN · found 2026-11-21 by Arpan

**Symptom.** `npm test` on Arpan's Windows machine: 3–4 "Unhandled Error: [vitest-pool]: Worker forks emitted error … Worker exited unexpectedly", a different file each run; no assertion fails. `npx vitest run --maxWorkers=2` passes all 910 tests (33 files).
**Cause.** Not confirmed. Likely memory: many test files each start an in-process Postgres (PGlite) in parallel forks.
**Blocks.** A red `npm test` / `npm run check` locally that is not a real failure. Possible fix: `maxWorkers` in `vitest.config.ts`.

<!-- Entry format:

### BUG-Katie-01
**One-line summary** · High/Medium/Low · OPEN · found 2026-11-21 by <name>

**Symptom.** What you saw, with the invoice or request that shows it.
**Cause.** If known.
**Blocks.** What it breaks for whom.
-->
