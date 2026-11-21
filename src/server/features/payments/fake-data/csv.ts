// TEMP: db — reads the delivered dataset straight from its CSVs until the schema and seed exist.

import { readFileSync } from "node:fs";
import path from "node:path";

/** RFC 4180-ish: quoted fields may contain commas, newlines and doubled quotes. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => r.length > 1 || r[0] !== "");
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

/** A fixed folder, so the Next build only bundles the dataset, not the whole project. */
export function readCsv(name: string): Record<string, string>[] {
  return parseCsv(readFileSync(path.join(process.cwd(), "brim_ap_dataset", "brim_ap_dataset", "data", name), "utf8"));
}

/** "2457.19" → 245719. String math only, never a float. TEMP: core/money. */
export function dollarsToCents(value: string): number {
  const s = value.trim().replace(/,/g, "");
  const m = s.match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) throw new Error(`Not a money amount: "${value}"`);
  const cents = Number(m[2]) * 100 + Number((m[3] ?? "0").padEnd(2, "0"));
  return m[1] === "-" ? -cents : cents;
}
