import type { CodedLine } from "./context";
import { normalizeDocNumber, tokenize } from "./text";

/**
 * Everything coded so far, indexed so a suggestion never scans the whole history:
 *   by vendor (newest first)            → "12 of the last 12 lines"
 *   by vendor + invoice number          → the invoice a credit note reverses
 *   by word (inverted index) + word idf → similar lines at other vendors
 *
 * Built once from the history, then `add()` each line a person accepts or changes, so a
 * correction is evidence for the very next invoice (the learning loop). At 100× volume this is
 * the "precomputed vendor → account table" from the architecture overview; in Postgres it would
 * be a query over invoice_lines with an index on (vendor_id, invoice_date desc).
 */

export interface IndexedLine extends CodedLine {
  tokens: string[];
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

const newestFirst = (a: IndexedLine, b: IndexedLine) =>
  b.invoiceDate.localeCompare(a.invoiceDate) ||
  (b.codedAt ?? "").localeCompare(a.codedAt ?? "") ||
  b.invoiceId.localeCompare(a.invoiceId) ||
  a.lineNo - b.lineNo;

export class CodingIndex {
  private readonly byVendor = new Map<string, IndexedLine[]>();
  private readonly sortedVendors = new Set<string>();
  private readonly byDocument = new Map<string, IndexedLine[]>();
  private readonly postings = new Map<string, IndexedLine[]>();
  private lines = 0;

  static from(lines: Iterable<CodedLine>): CodingIndex {
    const index = new CodingIndex();
    for (const line of lines) index.add(line);
    return index;
  }

  /** Adds one coded line. O(words in the description). */
  add(line: CodedLine): void {
    const indexed: IndexedLine = { ...line, tokens: tokenize(line.description) };
    this.lines++;
    push(this.byVendor, line.vendorId, indexed);
    this.sortedVendors.delete(line.vendorId);
    if (line.invoiceNumber) push(this.byDocument, `${line.vendorId}|${normalizeDocNumber(line.invoiceNumber)}`, indexed);
    for (const t of indexed.tokens) push(this.postings, t, indexed);
  }

  get size(): number {
    return this.lines;
  }

  /** This vendor's coded lines, newest first. */
  vendorLines(vendorId: string): readonly IndexedLine[] {
    const list = this.byVendor.get(vendorId) ?? [];
    if (!this.sortedVendors.has(vendorId)) {
      list.sort(newestFirst);
      this.sortedVendors.add(vendorId);
    }
    return list;
  }

  /** The lines of the vendor's invoice with this number (credit note → original invoice). */
  documentLines(vendorId: string, invoiceNumber: string): readonly IndexedLine[] {
    return this.byDocument.get(`${vendorId}|${normalizeDocNumber(invoiceNumber)}`) ?? [];
  }

  /** Lines sharing at least one word with `tokens`: the only ones worth scoring. */
  linesSharingWords(tokens: readonly string[]): IndexedLine[] {
    const seen = new Set<IndexedLine>();
    for (const t of tokens) for (const l of this.postings.get(t) ?? []) seen.add(l);
    return [...seen];
  }

  /** Every coded line whose description has this word. */
  linesWithWord(token: string): readonly IndexedLine[] {
    return this.postings.get(token) ?? [];
  }

  /** Inverse document frequency: rare words ("racking") weigh more than common ones ("service"). */
  readonly idf = (token: string): number => {
    const df = this.postings.get(token)?.length ?? 0;
    return Math.log((this.lines + 1) / (df + 1)) + 1;
  };
}
