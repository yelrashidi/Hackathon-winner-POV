# Brim AP — Harborline Logistics

Accounts payable automation for a business-card platform, built for the Brim hackathon. A
supplier invoice goes **inbox → read → code → check → approve → pay → prove it**, for the
fictional Harborline Logistics (40 people, ~50 suppliers, Canadian taxes, CAD and USD).
All data is synthetic and payments are simulated.

Where the project is right now: [`docs/STATUS.md`](../docs/STATUS.md), printed at the start of
every session by a hook. What we are building and what is out of scope:
[`docs/product.md`](../docs/product.md). The domain in plain words:
[`docs/explainers/Brim_AP_Automation_Challenge_Explained.md`](../docs/explainers/Brim_AP_Automation_Challenge_Explained.md).

**This is a 4-person hackathon.** Each person owns features (owners are in `STATUS.md`). Speed
matters, but judges score **working features on hidden invoices (40%)** and **every member
explaining the design in a live Q&A (25%)**. Code nobody on the team can explain is a liability.

## The stack

- **Next.js App Router + TypeScript** for the UI, one dashboard per role.
- **TypeScript backend** in `src/server/` — services that route handlers and server actions call.
  The browser never talks to the database.
- **PostgreSQL.** Local: Docker. Deployed: see [`overview.md`](../docs/architecture/overview.md#deployment).
- **Zod schemas in `src/contracts/`** are the hand-off between pipeline stages, and the only
  thing that crosses feature boundaries ([`docs/rules/contracts.md`](../docs/rules/contracts.md)).
- **LLMs only where judgment is fuzzy:** email classification, extraction, coding suggestions.
  Never for validation, duplicate verdicts, approval routing or permissions — those are
  deterministic code a judge can question.

## Where the code lives (target layout — update when it changes)

```
app/                      Next.js routes, one area per role (inbox, review, approvals, payments, vendors, audit)
src/
├── contracts/            Zod schemas + inferred types for every stage hand-off. Shared, owned by all.
├── server/
│   ├── db/               schema + migrations (one owner merges these — see STATUS.md)
│   ├── core/             FOUNDATION: fire() state machine, authorize(), audit emitter, fx, money
│   └── features/         one folder per feature: intake, extraction, coding, validation,
│                         duplicates, approvals, payments, audit, vendors
fixtures/                 frozen JSON outputs of each stage, so downstream work never waits on upstream
brim_ap_dataset/          the Harborline dataset as delivered (read its README.md); never edit it.
                          data/*.csv = reference + history, inbox/emails.json, incoming_invoices/ = the batch
scripts/                  seed.ts, eval.ts (runs the golden invoices and diffs expected flags)
docs/                     everything below
```

## The map — read the one file your task needs

| About to… | Read |
|---|---|
| Understand the system, pipeline and deploy | [`docs/architecture/overview.md`](../docs/architecture/overview.md) |
| Touch a table or write a migration | [`docs/architecture/data-model.md`](../docs/architecture/data-model.md) + [`docs/rules/db.md`](../docs/rules/db.md) |
| Add a permission check, role screen or approval rule | [`docs/architecture/roles-and-permissions.md`](../docs/architecture/roles-and-permissions.md) + [`docs/rules/backend.md`](../docs/rules/backend.md) |
| Change an invoice status | [`docs/explainers/brim-ap-diagrams.md`](../docs/explainers/brim-ap-diagrams.md) (state machine) — then go through `fire()` |
| Work inside one feature | `docs/architecture/<feature>.md` — index in [`docs/architecture/README.md`](../docs/architecture/README.md) |
| Change what one stage outputs | [`docs/rules/contracts.md`](../docs/rules/contracts.md) — **mandatory**, it breaks a teammate otherwise |
| Touch amounts, tax or currency | [`docs/rules/money-and-tax.md`](../docs/rules/money-and-tax.md) |
| Build UI | [`docs/rules/frontend.md`](../docs/rules/frontend.md) |
| Pick up work | [`docs/todo/TODO.md`](../docs/todo/TODO.md) — grep your feature's section; done work is in [`tasks-completed.md`](../docs/todo/tasks-completed.md) |
| Fix or report a defect | [`docs/bugs/bugs.md`](../docs/bugs/bugs.md) (open) · [`fixed-bugs.md`](../docs/bugs/fixed-bugs.md) — grep, do not read whole |

Rules in `docs/rules/` do **not** load by themselves. Before editing files a rule's `paths:`
covers, read that rule. They are short on purpose.

## Hard rules

1. **Status changes go through `fire(invoiceId, event, actor)`** — never a raw `UPDATE … status`.
   `fire()` checks the transition is legal, checks the guard, and writes the audit event in the
   same transaction. A status write that skips it is a hole in the audit trail.
2. **Every mutating endpoint calls `authorize()` on the server.** Hiding a button is cosmetic;
   judges will call the API directly as the wrong role. Separation of duties (no approving your
   own request, no releasing what you approved) lives in `authorize()`, not in the UI.
3. **Every mutation writes an audit event in the same transaction**, with the real actor and,
   for delegates, `on_behalf_of`.
4. **No dataset-specific answers in logic.** No invoice numbers, vendor names or amounts from
   the sample data in `if` statements. Scoring runs on invoices we have never seen.
5. **Money is integer cents; rates are decimals; never JavaScript floats for money**
   ([`money-and-tax.md`](../docs/rules/money-and-tax.md)).
6. **Every flag explains itself**: a stable `code`, a severity, and a message with the actual
   numbers — `Unit price $250.00 exceeds contract cap $230.00 (contract C-014)`.
7. **Stay in your feature folder.** Changing `src/contracts/`, `src/server/core/` or the schema
   affects teammates: say so in the PR title and in `STATUS.md`.
8. **Never assume a decision.** Open ones are listed in `STATUS.md`. Ask with `AskUserQuestion`.
9. **Three attempts without progress: stop and report** what you tried.

## Before a unit of work ends

Run `/wrap-up`. It verifies, updates **only your own section** of `STATUS.md`, moves finished
TODO items, files bugs, adds a rule line for any trap you hit, updates the feature doc, and
hands back a commit message.

## Conventions

- Commit subjects: `type(area): summary` — see `/commit-msg`.
- Bug ids are `BUG-<Name>-<nn>` (e.g. `BUG-Katie-03`), named after whoever filed it, so four people never collide. Team: Arpan, Youssef, Andrew, Katie.
- TODO items end with their owner's name in brackets: `[Youssef]`.
- Flag codes are `SCREAMING_SNAKE` and stable once a UI or test uses them (`TAX_PROVINCE_MISMATCH`).
- Claims in docs cite `file:line`. Dates are absolute (`2026-11-21`), never "yesterday".
