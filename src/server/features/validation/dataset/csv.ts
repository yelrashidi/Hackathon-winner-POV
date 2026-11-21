import { readFileSync } from "node:fs";
import path from "node:path";

/** Dataset folder (read-only input, docs/rules/db.md). Override with BRIM_DATA_DIR. */
export const DATASET_DIR = process.env.BRIM_DATASET_DIR ?? path.resolve(process.cwd(), "brim_ap_dataset/brim_ap_dataset");
export const DATA_DIR = process.env.BRIM_DATA_DIR ?? path.join(DATASET_DIR, "data");

/** Dataset as-of date (dataset README). */
export const DATASET_AS_OF = "2026-11-02";

/** RFC 4180 CSV → rows keyed by header. Handles quoted fields with commas, quotes and newlines. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.some((x) => x !== "")) rows.push(row);
  }
  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

export function readCsv(file: string, dir = DATA_DIR): Record<string, string>[] {
  return parseCsv(readFileSync(path.join(dir, file), "utf8"));
}
