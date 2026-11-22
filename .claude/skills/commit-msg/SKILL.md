---
name: commit-msg
description: Write a git commit message for Brim AP, and commit or push it only when asked. Use when the user asks for a commit message, or at the end of /wrap-up.
---

**Write the commit message. Commit or push only when the user asks for it** — then stage exactly
the files listed for each commit (never `git add -A`), commit on the current branch (branch first
if it is `main`), and push only the current branch. Otherwise print the message in a code block so
it can be copied. If the changes are more than one logical change, give one message per commit
and list which files belong to each. Never include `.env*` files in a suggested commit.

Format:

```
<type>(<area>): <what changed, imperative, under 70 characters>

<why, and anything a teammate must know: 1-3 short lines, optional>
```

- **type:** feat, fix, refactor, test, docs, chore
- **area:** intake, extraction, coding, validation, duplicates, approvals, payments, audit,
  vendors, core (fire / authorize / audit emitter / fx / money), contracts, db, seed, ui, docs
- **A change to `src/contracts/`, `src/server/core/` or the schema says so in the body** and
  names the teammates it affects — those are the commits that break someone else's feature.
- One logical change per commit. Mention the TODO item when it completes one, and the bug id
  (`BUG-Katie-03`) when it fixes one.
- No attribution: do not add a `Co-Authored-By` line or any other AI or tool credit, even if
  the session provides one.
