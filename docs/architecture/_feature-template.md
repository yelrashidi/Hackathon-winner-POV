# <Feature #> — <name>

<!-- Copy to docs/architecture/<feature>.md, e.g. 4-validation.md, and add a line to README.md.
     Keep it to one screen. This is what you will be quizzed on in the Q&A. -->

**Owner:** <name> · **Code as of:** `<short sha>` or never

## What it does
Two or three sentences. What goes in, what comes out, which status transitions it fires.

## Contract
- Input: `src/contracts/<x>.ts` → `<TypeName>`
- Output: `<TypeName>`, persisted to `<table>`
- Fixtures: `fixtures/<stage>/`

## How it decides
The actual logic, in prose or pseudo-code. For anything LLM-based: the prompt's job, how output
is validated (Zod), and what happens when validation fails.

## Flags it raises
| Code | Severity | Fires when | Message example |
|---|---|---|---|

## Bad input
Blurry scan, French, missing field, unknown vendor, USD, credit note, odd date — what happens to each.

## At 100× volume
What gets slow or expensive first, and what we would change.

## Known gaps
What we cut, and why.
