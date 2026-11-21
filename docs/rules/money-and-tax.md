---
description: Amounts, currency, FX and Canadian sales tax — where most silent bugs will be
paths:
  - "src/server/core/money*"
  - "src/server/core/fx*"
  - "src/server/features/extraction/**"
  - "src/server/features/validation/**"
  - "src/server/features/approvals/**"
  - "src/server/features/payments/**"
---

# Money and tax

- **Amounts are integer cents everywhere** — DB, contracts, code. Never `0.1 + 0.2`. Parse
  extracted strings straight to cents (`"2,260.00"` and the French `"2 260,00 $"` both → `226000`).
- **Rates are decimals, not floats in money math.** Compute tax as `round(base_cents * rate)` once
  per tax line with one rounding rule (half-up), in `core/money`. Compare to the invoice with a
  tolerance of 1 cent per line, or rounding differences become false flags.
- **Every limit is compared in CAD** — approval limits, the $100k release limit, split-invoice
  sums. USD converts at the `fx_rates` rate for the **invoice date** (nearest earlier business day
  if missing), and the rate used is stored on the invoice.
- **Tax is checked against the province of delivery** (`ship_to_province`), not the vendor's
  address. Unknown delivery province → `warn`, not a guess.
- **Tax codes come from the dataset table**, never hardcoded rates. ON: HST 13%. BC: GST 5% + PST 7%
  (two lines). QC: GST 5% + QST 9.975% (two lines). AB (Calgary office): GST 5% only. Any other
  province, foreign and exempt: whatever the table says — never fall back to a default rate.
- **BC PST applies to goods only** (`invoice_lines.line_type = goods`); PST on a services line is a flag.
  QST is on the pre-tax amount, not on GST. Insurance is exempt. (dataset `README.md`, `tax_codes.csv`)
- **Recoverable tax is not expense.** GST/HST → 1160, QST → 1165 (per `tax_codes.gl_account`).
  BC PST is **not** recoverable, so it is part of the line's expense.
- **Credit notes are negative totals.** They are not paid out by EFT; every `> 0` assumption in
  validation and payments must say what it does with a negative.
- **An unmapped tax line is not "no tax".** Never report a tax missing while a tax line has no code — it may be that tax (BUG-Andrew-03).
