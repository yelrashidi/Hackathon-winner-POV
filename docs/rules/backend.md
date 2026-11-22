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
- **A document's type comes from the document itself, never from the email around it.** "Invoice attached" can carry a brochure; only a document read as invoice/credit note becomes a bill (BUG-Arpan-01). Payment terms like "Due on receipt" contain "receipt": strip them before matching non-bill words.
- **Check who may never act before following a delegation** — a delegate must not sign for an excluded person (BUG-Youssef-01).
- **Decide who may act from today's users table at request time**, not from who was assigned earlier (BUG-Youssef-03).
- **An override unblocks; it does not make the condition false** — rules keyed on the flag still apply (BUG-Youssef-04).
- **Write exactly what was authorized**: take the actor and action from the authorization result, not from separate arguments (BUG-Youssef-05).
- **Next.js can load a server module more than once**, so module-level state (an in-memory store, a "seeded" flag) is not one per process; share it on `globalThis` or set it up per module copy (BUG-Katie-01).
- **No `import "server-only"` under `src/`**: `npm run check:imports` loads every module with tsx and it throws there (BUG-Katie-02).
- **Authorize (and `recordDenied`) before `withAction` opens the transaction** — logging a refusal from inside it waits on its own connection (BUG-Andrew-04).
- **A mailbox cursor may advance only after every covered page and message is fetched**; a page size must never become a silent delivery cap (BUG-Arpan-02).
- **A new entry point is not done until it calls the persistence path**: run it against Postgres and count rows, not just the service's tests. A mailbox cursor advances only after every email is saved (BUG-Andrew-06).
