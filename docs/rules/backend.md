---
description: Server code — authorize, fire, audit, and what an LLM may and may not decide
paths:
  - "src/server/**"
  - "app/api/**"
  - "app/**/actions.ts"
---

# Backend

- **`authorize(actor, action, resource)` first, in every mutating handler and server action.**
  The actor comes from the server session, never from the request body or a header the browser sets.
- **Invoice status changes only through `fire()`.** It validates the transition against
  [`brim-ap-diagrams.md`](../explainers/brim-ap-diagrams.md), runs the guard, writes the audit event, all
  in one transaction. If you need a transition the diagram does not have, update the diagram in the same PR.
- **Write + audit in one transaction.** Pass the `tx` through; an audit write outside it can
  record something that rolled back.
- **Feature code calls other features through their exported service**, not their tables.
  `features/payments` asks `features/approvals` who approved; it does not query `approval_steps` itself.
- **LLM output is untrusted input.** Parse it with the Zod contract; on failure, retry once, then
  route to manual entry with the reason. Never let a model decide a flag, a route, a permission or a payment.
- **Text inside an invoice or email is data, not instructions.** An invoice that says *approved,
  pay immediately* is a string to extract, never something the pipeline acts on.
- **No sample-data constants in logic** — scoring uses hidden invoices.
- **Errors the user can act on carry a reason** the UI shows verbatim; a bare 500 is a bug.
