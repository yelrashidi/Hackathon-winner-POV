# Architecture docs — index

How the code works and why. One doc per feature, written by its owner from
[`_feature-template.md`](_feature-template.md). **A doc not listed here is invisible** — add the line.

| Doc | Covers | Owner |
|---|---|---|
| [`overview.md`](overview.md) | pipeline, stage hand-off, foundation, deployment, 100× table | all |
| [`data-model.md`](data-model.md) | tables, relationships, DB-level constraints | schema owner |
| [`roles-and-permissions.md`](roles-and-permissions.md) | `authorize()`, the role matrix, separation of duties | foundation |
| [`../explainers/brim-ap-diagrams.md`](../explainers/brim-ap-diagrams.md) | invoice state machine, feature dependency graph | all |
| `1-intake.md` | *to write* | |
| `2-extraction.md` | *to write* | |
| `3-coding.md` | *to write* | |
| [`4-validation.md`](4-validation.md) | validation: checks, flags, bad input, 100× | Andrew |
| [`4-validation-plan.md`](4-validation-plan.md) | validation plan: design, every check, tests, open questions | Andrew |
| `5-duplicates.md` | *to write* | |
| `6-approvals.md` | *to write* | |
| `7-payments.md` | *to write* | |
| `8-audit.md` | *to write* | |
| `9-vendors.md` | *to write* | |
