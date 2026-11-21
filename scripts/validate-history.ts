/**
 * Replays the 426 historical invoices through validation and counts flags per code: the
 * false-positive check. History is mostly clean paid invoices, so every `block` here must be a
 * real problem in the data, never noise. Each invoice is checked against all the others.
 *   npm run validate:history              summary
 *   npm run validate:history -- CODE      list the invoices raising CODE
 */
import { validateInvoice } from "@/server/features/validation/engine";
import { historicalInputs } from "@/server/features/validation/dataset/history";
import { loadDatasetContext, readDatasetTables } from "@/server/features/validation/dataset/load-context";

const only = process.argv[2];
const tables = readDatasetTables();
// purchase_orders.csv holds TODAY's status: POs these invoices used up are now "closed". When each
// invoice arrived its PO was open, so replay with POs open (the balance check still applies).
const ctx = loadDatasetContext({ ...tables, purchaseOrders: tables.purchaseOrders.map((p) => ({ ...p, status: "open" })) });
const status = new Map(tables.invoices.map((r) => [r.invoice_id!, r.status!]));
const inputs = historicalInputs(tables);

const counts = new Map<string, { severity: string; n: number; invoices: string[] }>();
for (const input of inputs) {
  const r = validateInvoice(input, ctx);
  for (const code of new Set(r.flags.map((f) => f.code))) {
    const f = r.flags.find((x) => x.code === code)!;
    const c = counts.get(code) ?? { severity: f.severity, n: 0, invoices: [] };
    c.n++;
    c.invoices.push(`${input.invoiceId} (${status.get(input.invoiceId)})`);
    counts.set(code, c);
    if (only === code) console.log(`${input.invoiceId} [${status.get(input.invoiceId)}] ${f.message}`);
  }
}
if (!only) {
  console.log(`${inputs.length} historical invoices\n`);
  for (const [code, c] of [...counts.entries()].sort((a, b) => a[1].severity.localeCompare(b[1].severity) || b[1].n - a[1].n)) {
    console.log(`${c.severity.padEnd(5)} ${code.padEnd(32)} ${String(c.n).padStart(4)}  ${c.invoices.slice(0, 6).join(", ")}${c.n > 6 ? ", …" : ""}`);
  }
}
