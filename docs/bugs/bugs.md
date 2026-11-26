# Open bugs

Resolved ones move to [`fixed-bugs.md`](fixed-bugs.md) with the fix and the reason.

**Ids are `BUG-<Name>-<nn>`**, named after whoever files it: `BUG-Arpan-nn`, `BUG-Youssef-nn`, `BUG-Andrew-nn`, `BUG-Katie-nn`. Add the owner of the affected feature in the table.
Grep both files for your own highest id before filing; ids are never reused.

| ID | Severity | Feature (owner) | Summary |
|---|---|---|---|
| BUG-Arpan-08 | Low | tests (shared) | `npm test` workers crash ("Worker exited unexpectedly") at the default worker count; `--maxWorkers=2` passes |
| BUG-Andrew-13 | Medium | duplicates (Arpan) + core | A Finance Manager or manager can void a duplicate by calling the server action; only the button is hidden |
| BUG-Andrew-14 | Medium | intake (Arpan) | Gmail poller crash-loops on a message deleted after it arrived (404) and never advances its cursor |

---

### BUG-Arpan-08
**`npm test` workers crash under load** · Low · OPEN · found 2026-11-21 by Arpan

**Symptom.** `npm test` on Arpan's Windows machine: 3–4 "Unhandled Error: [vitest-pool]: Worker forks emitted error … Worker exited unexpectedly", a different file each run; no assertion fails. `npx vitest run --maxWorkers=2` passes all 910 tests (33 files).
**Cause.** Not confirmed. Likely memory: many test files each start an in-process Postgres (PGlite) in parallel forks.
**Blocks.** A red `npm test` / `npm run check` locally that is not a real failure. Possible fix: `maxWorkers` in `vitest.config.ts`.

### BUG-Andrew-13
**Duplicate decisions are wider on the server than on the screen** · Medium · OPEN · found 2026-11-25 by Andrew

**Symptom.** Only AP Clerks and Controllers see the duplicate buttons, but `confirmDuplicate` / `dismissDuplicate` (`src/server/features/duplicates/db/decide.ts`) authorize `invoice.review` / `flag.override`, which also allow `approver` and `finance_manager` (`core/authorize.ts`). Elise could void a duplicate with a direct call.
**Cause.** The team widened the checks permissions for managers on 2026-11-21; duplicates reused them.
**Blocks.** A judge calling the action as the wrong role. Fix: a `duplicate.decide` action for ap_clerk + controller_admin (TODO, team call: shared `core/`).

### BUG-Andrew-14
**Gmail poller crash-loops on a deleted message** · Medium · OPEN · found 2026-11-25 by Andrew

**Symptom.** `docker compose ps` shows `gmail-poller` "Restarting"; logs end in a gaxios 404 "Requested entity was not found" for `users/me/messages/<id>`.
**Cause.** `fetchMessages` (`src/server/features/intake/gmail/poll.ts:47`) does not catch a 404 for a message listed in history but deleted since; the poll throws before the cursor is saved, so every restart hits the same id.
**Blocks.** Live email intake in the demo (`docs/demo-workflow.md`). Fix: skip a 404 like the expired-cursor case, record it in `rejected`.

<!-- Entry format:

### BUG-Katie-01
**One-line summary** · High/Medium/Low · OPEN · found 2026-11-21 by <name>

**Symptom.** What you saw, with the invoice or request that shows it.
**Cause.** If known.
**Blocks.** What it breaks for whom.
-->
