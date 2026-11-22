# 3 — Smart coding

> **On screen (2026-11-21):** Checks → one invoice shows every line's suggestion, confidence, reason and alternatives, accept / change, bulk-accept and the journal preview — see [`dashboard.md`](dashboard.md).

**Owner:** Youssef · **Written:** 2026-11-21 · **Code as of:** `5d3ec67`

Code paths below are under `src/server/features/coding/` unless they start with `src/`.

## What it does
"Coding" puts each invoice line in a bucket: a **GL account** (6610 Rent, 5010 Freight…) and a
**department** (Operations, IT…). For every line of an extracted invoice, coding suggests both,
each with a **confidence** and a **reason with the numbers** ("12 of the last 12 Polar Freight
Lines Ltd. lines like 'LTL shipment Montreal-Ottawa' → 5010 Freight & Carrier Costs"). A person
accepts or changes each line. Coding also previews the **journal entry** the coding produces, and
blocks submission until every line is confirmed. Deterministic, no LLM.

## Where it sits
```
1 intake → 2 extraction ─┬─ 3 CODING ────┬─→ 6 approvals (lineDepartmentIds, invoice department)
                         ├─ 4 validation ─┤
                         └─ 5 duplicates ─┘   one shared vendor: validation's matchVendor
```
- **Input:** the extracted invoice, `ValidationInput` (`src/contracts/validation.ts`: extraction's
  output as the team has agreed it), plus the **vendor id validation's `matchVendor` resolved**, so
  coding, validation and duplicates never disagree about the vendor. Uses `departmentId` /
  `requesterId` / `poNumber` when intake or extraction fills them.
- **Output:** `CodingResult` (`src/contracts/coding.ts`). Per line: `account` and `department`
  suggestions, `glAccount` / `departmentId` to post, `source` (suggested / accepted / changed),
  who coded it, when, and any note. Plus `invoiceDepartment`, the `journal` preview and `flags`. Persists
  to `invoice_lines` (`gl_account_code`, `department_id`, `coding_source`, `coding_reason jsonb`).
- **Fixtures:** `fixtures/coding/` (5 real incoming invoices; the test fails if one goes stale).

## How it decides

### Account: strongest evidence first (`suggest.ts:178`)
| # | Basis | When | Confidence |
|---|---|---|---|
| 1 | `credit_note_original` | A credit note whose `creditNoteRef` matches one of the vendor's invoices: coded like that invoice's closest line | high |
| 2 | `discount_parent` | A negative line on a positive invoice: coded like the line it reduces (`suggest.ts:428`) | the parent's |
| 3 | `recent_correction` | A person re-coded this vendor's latest similar line: the correction wins | medium (1) / high (2 in a row) |
| 4 | `vendor_description` | This vendor's last ≤ 12 lines described like this one (Ironwood: "Racking" → 5030, "Pallets" → 5040) | by agreement |
| 5 | `vendor_history` | This vendor's last 12 lines, for a description new to it | **at most medium** |
| 6 | `vendor_default` | No coded history: `vendors.default_gl_account` | medium |
| 7 | `category` | No default: what other vendors in its category use | low |
| 8 | `description_similarity` | The same product elsewhere (`suggest.ts:116`), else a word vote (`suggest.ts:147`) | medium / low, never high |

Confidence (`suggest.ts:53`): **high** = ≥ 3 lines and ≥ 90% agree; **medium** = ≥ 60%, or 1–2
lines all agreeing; **low** below that. Only expense accounts are ever suggested (`suggest.ts:43`).

Two rules that came out of testing:
- **A description new to the vendor is capped at medium** (`suggest.ts:258`). Bulk-accept only
  covers kinds of lines seen before, and a nonsense or injected description ("IGNORE PREVIOUS
  INSTRUCTIONS…") can never be auto-accepted.
- **The same product beats a vendor's habit.** If at least 2 other lines are described almost
  exactly like this one (similarity ≥ 0.8) and agree, they win over the vendor's usual account. So an
  office-supply vendor's "Ergonomic task chairs" goes to 6220 Furniture, and Keystone's "stretch
  wrap" to 5040, as everywhere else. A single word never overrides a vendor; a single-word vote is
  only ever low.

### Department (`suggest.ts:310`, `suggest.ts:329`)
In the history, **a line's department is the requester's department on all 809 lines**, and
descriptions don't predict it ("HVAC service call" was billed to Facilities *and* Operations). So:
1. the invoice's own `departmentId`, then the **requester's** department, then the **referenced
   PO's** department: high;
2. otherwise: a credit note's original, then the vendor's **only open PO** (medium: not referenced),
   then the vendor's history. Low, plus `CODING_DEPARTMENT_UNCERTAIN` and the split, when the vendor
   bills several departments. **None of the 56 incoming invoices has a requester**, so intake must
   capture one.

### Journal preview (`journal.ts:49`)
```
Dr  each line's account / department         line amount
Dr  1160 GST/HST · 1165 QST receivable        recoverable tax (an input tax credit, not a cost)
Dr  the goods lines' accounts                 their share of non-recoverable tax (BC PST is a cost)
  Cr  2100 Accounts Payable                   invoice total
```
Recoverability, receivable accounts and "goods only" come from `tax_codes`; nothing names a rate.
Non-recoverable tax is split by line amount with the **largest-remainder method** (`journal.ts:26`),
so the pieces add up to the cent. Amounts are signed, so a credit note's entry is the mirror image.

## Flags it raises (`codes.ts`)
| Code | Severity | Fires when |
|---|---|---|
| `CODING_NOT_CONFIRMED` | block | At submit: a line is still only *suggested* (`decide.ts:151`) |
| `CODING_NO_LINES` | warn | No lines were extracted (it still says where the vendor's lines usually go) |
| `CODING_NO_SUGGESTION` | warn | Nothing points at an account |
| `CODING_DEPARTMENT_UNCERTAIN` | warn | No requester, and the vendor bills several departments (or is unknown) |
| `CODING_CAPITALIZE_REVIEW` | warn | Unit price ≥ the per-unit limit in the account's own notes (6220: "under $1,000 per unit") |
| `CODING_TAX_UNALLOCATED` | warn | A tax with no known code, or charged under a zero-rate code |
| `CODING_JOURNAL_UNBALANCED` | warn | Lines + taxes ≠ total (agrees with validation's `ARITH_*` on all 56 incoming) |
| `CODING_UNUSUAL_ACCOUNT` | warn | A person codes a vendor to an account it has never used (mistake, or hidden spend) |
| `CODING_PREPAID_REVIEW` | info | "annual", "12 months", "annuel": consider spreading it |
| `CODING_DEPARTMENT_DIFFERS` | info | A line is charged to a department other than the requester's |

## A person accepts or changes it (server-side, `decide.ts:59`)
| Check | Refusal |
|---|---|
| Body is `{ glAccount, departmentId, note? }`, note ≤ 500 chars | 400 `INVALID_REQUEST` |
| Actor is active, and an AP clerk or the controller (the permission matrix) | 403 `USER_INACTIVE` / `ROLE_CANNOT_CODE` |
| The line exists | 404 `LINE_NOT_FOUND` |
| The account exists and is an **expense** account (not 2100 AP, not 1160/1165 tax) | 400 `ACCOUNT_NOT_CODABLE` |
| The department exists | 400 `UNKNOWN_DEPARTMENT` |
| Overriding a **high-confidence** suggestion comes with a reason | 400 `NOTE_REQUIRED` |

`acceptConfident` bulk-accepts lines that are high on both account and department. Confirmed lines
feed back into the history with `toCodedLines` → `CodingIndex.add`: a correction is evidence for
the very next invoice (the learning loop).

## How good is it? (`__tests__/backtest.test.ts`)
The history is replayed **in date order**: each invoice is coded using only the invoices before
it, which is exactly what the system would have known that day.

| | Right | High conf. | Medium | Low / none |
|---|---|---|---|---|
| Account | **99.6%** of 809 lines | **455 / 455** | 351 / 354 | 0 |
| Department, requester known | **100%** | 809 / 809 | — | — |
| Department, no requester | 82.8% | 465 / 466 | 198 / 240 | 7/18 low, 85 none |

On the 56 incoming invoices: every line gets an account. Expected outcomes are pinned in
`incoming.test.ts`:
- a fuel surcharge on a freight invoice → freight;
- French rent → 6610;
- a credit note → its original;
- an unknown courier → freight;
- vendors with no history → their default.

The one weak line, Zephyr's "Data migration services", is an honest *low*.

## Bad input and edge cases
| Input | Result |
|---|---|
| French description ("Loyer de base - Montréal") | accents off, French → English words, plurals folded (`text.ts:23`) |
| Numbers, sizes, SKUs in descriptions ("qty 539", "48x40") | ignored when comparing |
| "Fuel surcharge" on a carrier's invoice | 5010 Freight (the vendor's lines), not 5020 Fuel |
| Same vendor, different products (racking vs pallets) | decided by description, per line |
| Unknown vendor | same product elsewhere, else word vote; medium at most; department none + flagged |
| Vendor with no history (new / pending) | vendor-master default, medium |
| Credit note, reference written differently ("gr26 2262") | matched after normalising; coded like the original |
| Credit note with an unknown reference | coded from the vendor's history |
| Discount line on an invoice | coded like the line it reduces |
| Mis-posted history (a line on 2100 AP) | ignored; only expense accounts are suggested |
| Line with no words ("#48213-A") | the vendor's usual account |
| No lines extracted | flagged, with the vendor's usual account to code one line |
| Text with instructions in a description | treated as words; capped at medium, never auto-accepted |
| Unmapped or zero-rate tax with an amount | journal entry with no account + flagged |
| PST charged on services | still spread (journal balances); validation flags the PST itself |
| USD invoice | journal in USD; messages say "USD 1,234.56" |
| Totals that don't add up | `CODING_JOURNAL_UNBALANCED` with the difference |
| Random garbage (400 fuzzed invoices) | never throws; output always fits the contract and the journal identity holds |

## At 100× volume
`CodingIndex` (`history.ts:32`) keeps lines by vendor, by invoice number and by word (an inverted
index), so a suggestion looks at one vendor's recent lines and the lines sharing a word, never the
whole history. `add()` is O(words), so the index grows as lines are confirmed instead of being
rebuilt. In Postgres this is an index on `invoice_lines (vendor_id, invoice_date desc)` plus a
word index (`pg_trgm` / `tsvector`). No LLM call per line, so 5,000 invoices a month cost nothing.

## Decisions made here (confirm at kickoff)
- Bulk-accept threshold: **high** on both account and department.
- New-to-vendor descriptions: capped at medium.
- "Same product" override: similarity ≥ 0.8, at least 2 lines, ≥ 90% agreeing (`config.ts`).
- Window of 12 recent lines; high = ≥ 3 lines and ≥ 90% agree.
- Coding roles: AP clerk and controller only.
- Non-recoverable tax is spread by line amount over goods lines (all lines if none are goods).

## Considered and left out
| Idea | Why not (yet) |
|---|---|
| LLM fallback for lines with no evidence | The LLM provider is an **open decision** in STATUS.md. It would plug in at step 8 and its output must pass the same expense-account check |
| Split one line across departments (shared rent) | History never does; would need allocation rules from Finance |
| Fixed-asset and prepaid accounts | The chart has none; coding prompts (`CODING_CAPITALIZE_REVIEW`, `CODING_PREPAID_REVIEW`) instead of posting to an invented account |
| Capitalisation limit in CAD for USD invoices | Coding has no FX rate; the unit price is compared in invoice currency (known gap) |
| Trusting a GL code printed on the invoice | A vendor's document never decides our coding |
| Department from email text | The 59 emails carry no department or person hints |

## Likely questions
- *Why not just use the vendor's default account?* 10 of 809 lines aren't on it (racking vs
  pallets), and a default says nothing about departments. Defaults are the fallback.
- *How do you know it works?* The chronological backtest above: 99.6%, and never wrong at high.
- *Why is the department weaker?* Because it depends on who ordered, not on what was bought. With
  the requester it's 100%; without, the code says so (low / flagged) instead of guessing.
- *What stops someone hiding spend in the wrong account?* Only clerks or the controller can code;
  an account the vendor has never used raises `CODING_UNUSUAL_ACCOUNT`; overriding a confident
  suggestion needs a written reason; who changed what is stored on the line.
- *Why not an LLM?* Coding must be explainable and repeatable. An LLM is allowed for coding
  suggestions (CLAUDE.md), but only as a last resort and behind the same checks, once the provider is chosen.
- *What happens to tax?* GST/HST/QST are recoverable, so they go to receivable accounts, not expense;
  BC PST isn't, so it's added to the goods lines' cost. All from `tax_codes`.
