---
name: commit-msg
description: Write a git commit message for Brim AP (message only, never commits). Use when the user asks for a commit message, or at the end of /wrap-up.
---

**Write the commit message only. Do not run `git add`, `git commit` or `git push`.** The user
stages and commits themselves, on the branch they choose. Print the message in a code block so
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
