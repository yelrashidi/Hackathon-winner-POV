/** Terminal output shared by gmail-poll and intake-dataset. */
import type { InboxMessage } from "../src/contracts/intake";
import type { IntakeResult } from "../src/server/features/intake/classify/classify";

const money = (cents: number | null, cur: string | null) =>
  cents === null ? "?" : `${cents < 0 ? "-" : ""}${(Math.abs(cents) / 100).toFixed(2)} ${cur ?? ""}`.trim();

export function printResult(m: InboxMessage, r: IntakeResult, opts: { verbose: boolean }) {
  const c = r.classification;
  console.log(`\n${m.externalId}  ${c.decision.toUpperCase()} (${c.kind}, by ${c.decidedBy})  "${m.subject}"  <${m.fromAddress}>`);
  console.log(`    ${c.reason}`);
  for (const d of r.readings) {
    const x = d.extracted;
    console.log(`    · ${d.filename}: ${d.verdict}${d.documentType ? ` / ${d.documentType}` : ""} by ${d.decidedBy}`
      + (x && d.verdict === "bill" ? ` — ${x.vendor.nameRaw ?? "?"} #${x.invoiceNumber ?? "?"} ${x.invoiceDate ?? "?"} total ${money(x.totalCents, x.currency)}` : "")
      + (d.error ? ` — error: ${d.error}` : ""));
    if (opts.verbose && x) {
      for (const l of x.lines) console.log(`        line ${l.lineNo}: ${l.description} | ${l.quantity} × ${money(l.unitPriceCents, null)} = ${money(l.amountCents, null)} (${l.lineType ?? "?"})`);
      for (const t of x.taxes) console.log(`        tax: ${t.label} → ${t.code ?? "UNMAPPED"} ${money(t.amountCents, null)}`);
      if (x.warnings.length) console.log(`        warnings: ${x.warnings.join("; ")}`);
    }
  }
}
