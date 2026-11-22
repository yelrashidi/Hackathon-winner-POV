## What

<!-- Feature # and one or two lines. Title format: type(area): summary. Prefix "contract:" if src/contracts changed. -->

## Touches shared code?

- [ ] `src/contracts/` — fixtures regenerated, downstream owners tagged
- [ ] `src/server/core/` (fire / authorize / audit / fx / money)
- [ ] schema / migration — schema owner reviewed
- [ ] none

## Checked

- [ ] `npm run typecheck` and `npm test` green
- [ ] `npm run eval` if the pipeline changed
- [ ] every new mutation calls `authorize()` and writes an audit event
- [ ] `/wrap-up` run (STATUS section, TODO, feature doc)

## Can a teammate explain this?

<!-- One sentence on the design choice someone could be asked about in the Q&A. -->
