# Architecture docs — index

How the code works and why. One doc per feature, written by its owner from
[`_feature-template.md`](_feature-template.md). **A doc not listed here is invisible** — add the line.

| Doc | Covers | Owner |
|---|---|---|
| [`overview.md`](overview.md) | pipeline, stage hand-off, foundation, deployment, 100× table | all |
| [`data-model.md`](data-model.md) | tables, relationships, DB-level constraints | schema owner |
| [`roles-and-permissions.md`](roles-and-permissions.md) | `authorize()`, the role matrix, separation of duties | foundation |
| [`../explainers/brim-ap-diagrams.md`](../explainers/brim-ap-diagrams.md) | invoice state machine, feature dependency graph | all |
| [`1-intake.md`](1-intake.md) | intake: Gmail connector, dataset inbox adapter, classifier, draft bills | Arpan |
| [`2-extraction.md`](2-extraction.md) | extraction: document type + fields per document, text rules, Claude, normalizer | Arpan |
| [`3-coding.md`](3-coding.md) | smart coding: evidence ladder, departments, journal preview, backtest, edge cases, Q&A | Youssef |
| [`4-validation.md`](4-validation.md) | validation: checks, flags, bad input, 100× | Andrew |
| [`4-validation-plan.md`](4-validation-plan.md) | validation plan: design, every check, tests, open questions | Andrew |
| [`5-duplicates.md`](5-duplicates.md) | duplicates: canonical numbers, second-copy rule, card merchant matching, human decision on the dashboard, 100× | Arpan |
| [`6-approvals.md`](6-approvals.md) | approval routing, separation of duties, the approve/reject gate | Youssef |
| [`6-approvals-edge-cases.md`](6-approvals-edge-cases.md) | every approvals edge case with `file:line` + test, what was left out, defaults to confirm | Youssef |
| [`6-approvals-study-guide.md`](6-approvals-study-guide.md) | Q&A prep: every function, the logic traced on a real invoice, design reasons, likely questions | Youssef |
| [`7-payments.md`](7-payments.md) | payments: schedule, release rules, simulated EFT, failures and urgency flags, bank change | Katie |
| [`9-vendors.md`](9-vendors.md) | vendor master: list, onboard + second-person approval, hold, bank change request + verify, conflicts for approvals | Andrew |
| [`8-audit.md`](8-audit.md) | audit trail + DB foundation: schema, append-only `audit_events`, `core/` (`withAction`, `fire`, `authorize`), the pipeline on Postgres (3→4→6→8), auditor dashboard services, control checks | Andrew |
| `9-vendors.md` | *to write* | |
