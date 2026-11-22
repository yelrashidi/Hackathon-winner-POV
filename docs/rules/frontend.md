---
description: Next.js UI — role screens, flags that explain themselves, server-side data only
paths:
  - "app/**"
  - "src/components/**"
---

# Frontend

- **This may be a newer Next.js than your training data.** Check `node_modules/next/dist/docs/`
  (or the installed version's docs) before relying on a remembered API.
- **Each role lands on its own home screen** ([`product.md`](../product.md#the-six-roles)). A
  first-time user must finish their task without help — that is 20% of the score.
- **Hiding a control is UX, not security.** Use `can()` to decide what to show; the server still
  runs `authorize()`. Never compute a permission only in the browser.
- **Render flags with one shared component** from the contract's `Flag` shape: severity colour,
  the message with its numbers, and the evidence (contract cap, matching invoice, card transaction) one click away.
- **Show the source next to the extracted value.** The review screen puts the PDF beside the
  fields; low-confidence fields are visibly marked.
- **Money is formatted from cents in one helper**, with the currency code; USD shows its CAD equivalent.
- **Data loads on the server** (server components or route handlers) through `src/server`
  services. No database client or secret in client components.
- **Delegate actions read as such everywhere**: *Approved by Priya Shah on behalf of Tom Lee*.
- **Database reads in a page or layout go after `await connection()`** (or after a cookie read is awaited). With `cacheComponents`, a read that starts during prerender fails on anything time-based, e.g. the embedded demo DB (BUG-Arpan-06).
- **A cookie read alone is not enough:** `new Date()` after `await cookies()` was still refused while prerendering (payments, 2026-11-21). Put `await connection()` before the reads.
