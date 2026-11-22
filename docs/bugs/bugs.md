# Open bugs

Resolved ones move to [`fixed-bugs.md`](fixed-bugs.md) with the fix and the reason.

**Ids are `BUG-<Name>-<nn>`**, named after whoever files it: `BUG-Arpan-nn`, `BUG-Youssef-nn`, `BUG-Andrew-nn`, `BUG-Katie-nn`. Add the owner of the affected feature in the table.
Grep both files for your own highest id before filing; ids are never reused.

| ID | Severity | Feature (owner) | Summary |
|---|---|---|---|
| BUG-Katie-03 | Medium | 8 Audit + foundation (Andrew) | `.env.example` is referenced but not in the repo |

---

<!-- Entry format:

### BUG-Katie-01
**One-line summary** · High/Medium/Low · OPEN · found 2026-11-21 by <name>

**Symptom.** What you saw, with the invoice or request that shows it.
**Cause.** If known.
**Blocks.** What it breaks for whom.
-->

### BUG-Katie-03
**`.env.example` is referenced but not in the repo** · Medium · OPEN · found 2026-11-21 by Katie

**Symptom.** Without a `.env`, the app and `npm run db:reset` fail with "DATABASE_URL is not set (see .env.example)" (`src/server/db/client.ts:34`, `scripts/db-reset.ts:13`), and `tasks-completed.md` lists `.env.example` as landed, but no commit on any branch has the file (`git log --all -- .env.example` is empty).
**Cause.** Probably created locally and never committed (`.gitignore` un-ignores it).
**Blocks.** Everyone running the app on Postgres (now every payments page) has to guess the variable names; the local values are only in `docker-compose.yml` and `docker/init/`.
