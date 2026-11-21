# Completed tasks

Finished work moved out of [`TODO.md`](TODO.md). Append-only, newest first. One entry per item:
date, owner, what landed, and anything learned that the next person should know.

Format:

```
- [x] **<item>** — 2026-11-21 · <Arpan/Youssef/Andrew/Katie> · <commit sha>. <one or two lines: what works, what is stubbed, what surprised you.>
```

---

- [x] **Approvals policy engine from `approval_policies` (P01–P13)** — 2026-11-21 · Youssef · `fb86afa`. Pure `planApprovals`; plans carry `invoiceVersion` but are not persisted yet (no schema). Every edge case: [`6-approvals-edge-cases.md`](../architecture/6-approvals-edge-cases.md).
- [x] **Self-approval escalation, delegation, absent approver** — 2026-11-21 · Youssef · `fb86afa`. Exclusions are checked before delegation, delegation is one hop, and the step is re-resolved at decision time, so leave and terminations after routing self-heal. Admin policy editor still open.
- [x] **Docs and agent setup** — 2026-11-20 · Arpan. `CLAUDE.md`, `product.md`, architecture overview, data model, roles, rules, STATUS, TODO, bugs, `/wrap-up`, `/commit-msg`.
