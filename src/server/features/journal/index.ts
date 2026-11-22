/**
 * Bonus feature — export approved bills and settled payments as an accounting journal (CSV),
 * for the accounting system Harborline posts to. Finance Manager and Controller/Admin only.
 * Doc: docs/architecture/journal-export.md.
 *
 *   previewJournal(actor, query)    entries, totals, what is left out and why
 *   exportJournal(actor, query)     the CSV + an audit event (what was posted, by whom)
 *   journalExports(actor)           export history
 */
export { previewJournal, exportJournal, journalExports, JournalExportError, type JournalQuery, type JournalPreview, type JournalExportRecord } from "./db";
export { billEntry, paymentEntry, toCad, journalCsv, JOURNAL_CSV_COLUMNS, type JournalEntryOut, type JournalLineOut, type Excluded } from "./build";
export { JOURNAL_ACCOUNTS, FX_GAIN_LOSS_ACCOUNT, POSTED_BILL_STATUSES } from "./config";
