---
name: wrap-up
description: End-of-unit checklist for Brim AP. Verifies the work, updates the owner's STATUS section, TODO, bugs, rules and feature doc, then writes the commit message. Run when a feature slice or fix is finished, before committing.
disable-model-invocation: true
---

# Wrapping up a unit of work

Fast, in order. Each step is a thing a teammate (or the next agent session) pays for if skipped.
If a step does not apply, say so in one line — do not skip it silently.

## 1. Verify

Run what exists of: `npm run typecheck`, `npm test`, and `npm run eval` if anything in the
pipeline changed. Red means not finished — stop here and report.

## 2. Contracts and shared code

`git diff --name-only main...` — if it touches `src/contracts/`, `src/server/core/` or the schema:

- fixtures regenerated and still parse;
- the affected owners (from `STATUS.md`'s team table) named in the report and the commit body.

## 3. STATUS.md — your section only

Replace your feature's section with: what works end to end, what is stubbed, what is next, who
you are waiting on. Two to five lines. Do not edit other people's sections. Update the shared
block only if you finished a shared item.

## 4. TODO

Tick finished items and move them to `docs/todo/tasks-completed.md` (date, owner, one-line note).
Add anything new you discovered under the right feature.

## 5. Bugs

New defect found and not fixed → `docs/bugs/bugs.md` with your next free `BUG-<YourName>-<nn>`
(grep both bug files first). Fixed one → move it to `fixed-bugs.md` with the fix and the cause.

## 6. Rules

A trap you hit that the next person would hit too → one line in the matching `docs/rules/*.md`,
citing the bug id. A paragraph belongs in a feature doc, not a rule.

## 7. Feature doc

Update `docs/architecture/<n>-<feature>.md` from the template — especially **Flags it raises**,
**Bad input** and **At 100×**. Re-stamp `Code as of:` with `git rev-parse --short HEAD`. If the
doc is new, add its line to `docs/architecture/README.md`.

## 8. Hand back

Report in five lines or fewer, then run `/commit-msg`. Do not commit.
