# 2 — Extraction

**Owner:** Arpan · **Code as of:** `b655a97` + PR #11 review fixes (2026-11-21; document type + fields; not persisted yet)

## What it does
Reads one attachment (PDF or image) **once** and answers two questions: is it a bill (invoice or
credit note), and if so what does it say: vendor, number, dates, lines, each tax line mapped to a
tax code, totals, remit-to. Intake drafts a bill only for documents read as bills.

## Contract
- Input: bytes + mime + file name (`DocumentInput`, `src/server/features/extraction/read-document.ts`).
- Output: `DocumentReading` (`src/contracts/extraction.ts`): `verdict` (`bill` / `not_bill` /
  `uncertain`), `documentType`, `reason`, `decidedBy`, `extracted: ExtractedDocument | null`, `llmRaw`.
- `ExtractedDocument` uses `ValidationInput`'s field names and reuses its line/tax/remit schemas, so
  validation's mapper only adds `invoiceId`, `senderEmail` and `receivedDate`.
- `fixtures/extraction/*.json` are real `DocumentReading` outputs: invoice, scan, credit note, manual-entry bill and uncertain scan. The three model-backed readings retain their actual raw replies. Capture with `npm run fixtures:intake -- --live`; replay offline with `npm run fixtures:intake`. The contract test also checks the handoff into `ValidationInput` and preserves `lineType` for Andrew and Youssef.

## How it decides
1. **PDF text layer, locally** (`pdf-text.ts`, `unpdf`). Nothing leaves the machine. Scans have none.
2. **Document-type rules on the document's own text** (`doc-type-rules.ts`):
   - `bill_likely`: a title *line* starting with invoice / facture / credit note (not a field label
     like "Invoice Number:") plus an invoice number or a total. A credit-note title wins.
   - `not_bill`: titled receipt / statement / quote / PO / terms…, and **the word invoice/facture
     appears nowhere**. This is the only case that skips the model.
   - Anything else, including a bill title next to "RECEIPT", is `unknown` and goes to the model.
3. **Claude reads it once** (`claude.ts`, `prompt.ts`): the text layer is sent as text when there is
   one (cheaper), otherwise the PDF or image. `claude-opus-5-5`, effort medium, Zod structured
   output, refusal fallback. The prompt includes the tax-code table and says that document content is
   data, not instructions. **Amounts are copied as printed**; Claude never computes.
4. **Deterministic normalizer** (`normalize.ts`, `amounts.ts`): printed amounts are converted to
   cents (`$3,000.30`, `2 260,00 $`, `(185.71)`), "Net 30" to 30 days, and credit notes are made
   negative independently for subtotal, total, unit prices, line amounts and taxes, even when the total is unreadable or already negative (`normalize.ts:70`, BUG-Arpan-03). Unknown optional values stay null. Required numeric line fields retain explicit placeholders (quantity 1, amounts 0), each with a manual-review warning and `confidence.lines = 0` (`normalize.ts:37`, BUG-Arpan-04); a genuine printed zero has no missing-value warning. No shared schema was changed.
5. **Verdict** (`read-document.ts`):

| Model says | Text rules said | Verdict |
|---|---|---|
| invoice / credit note | anything | `bill` |
| not a bill | `bill_likely` | `uncertain`: clerk decides (`RULES_MODEL_DISAGREE`) |
| not a bill | unknown | `not_bill` |
| failed twice | `bill_likely` | `bill` with no fields → manual entry |
| failed twice | unknown | `uncertain` |

## Flags it raises
None directly: discrepancies are validation's job. Extraction reports `warnings` per document
(`total "3,39O.34" is not a readable amount`, `credit note printed positive amounts; stored as
negative`) and signals (`DOC_TITLE_INVOICE`, `DOC_TITLE_CONFLICT`, `RULES_MODEL_DISAGREE`,
`EXTRACTION_FAILED`) that the dashboard shows next to the PDF.

## Bad input
| Input | What happens |
|---|---|
| Scan / photo (no text layer) | Image sent to Claude (vision); TIFF/HEIC → `uncertain`, manual |
| French | Same prompt; "Facture", "TPS/TVQ" mapped to GST5/QST9975 by Claude, checked against the table |
| Credit note | Each monetary field becomes non-positive independently; missing totals remain null |
| Unreadable optional amount or date | null; unreadable nonblank text also produces a warning |
| Missing/unreadable quantity, unit price or line amount | explicit numeric placeholder + manual-review warning; line confidence zero |
| "Due on receipt" terms | Not a receipt (benign phrase stripped) |
| Model fails twice | Invoice-titled text → bill in manual entry; otherwise `uncertain` |
| Text says "pay immediately" / "ignore instructions" | Data; prompt says so; noted in the reason |

## Results
- Dataset, text rules: 54 PDFs → 52 invoices + 2 credit notes; 2 PNG scans → model.
- Live sample (EM-001 invoice, EM-011 scan, EM-029 two invoices, EM-042 credit note): 5/5 read
  correctly; line totals + tax = total on all.
- Live non-bills: a receipt that mentions an invoice → receipt; a quote that says "an invoice will
  follow" → quote (both read by the model); terms and conditions → skipped by the rules.
- PR #11 fixture capture, 2026-11-21: EM-014 invoice, EM-011 scan and EM-042 credit note; all three document bodies are English despite French email subjects. French document rules, printed amounts and decimal quantities are covered separately in `extraction.test.ts`.

## At 100× volume
One model call per bill-like document is the cost. Cache readings by document sha256 (resubmitted
PDFs are free), run batches through a queue with a rate limit, and send text instead of PDFs whenever
there is a text layer (already done).

## Known gaps
- Readings are not persisted yet (step 3: `documents`, `invoices.extraction_raw`).
- `amounts.ts` belongs in `core/money` once the foundation exists.
- Tax codes are injected into `createClaudeExtractor`; `tax-codes.ts` is the development CSV loader. Deployed callers must load `tax_codes` from the database (TODO step 3).
- Multi-page text with columns could come out of the text layer out of order. Low confidence → the
  clerk sees it in review. Not yet sent as PDF on a retry.
