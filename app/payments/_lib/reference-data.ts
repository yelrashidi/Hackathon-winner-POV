import "server-only";

// TEMP: departments and tax codes read straight from the dataset CSVs until the foundation's
// tables exist. Used by the upload form's dropdowns.

import { readFileSync } from "node:fs";
import path from "node:path";
import { parseCsv } from "@/server/session/users";

const DATA_DIR = path.join(process.cwd(), "brim_ap_dataset/brim_ap_dataset/data");

/** Rows as objects; reading a column the file doesn't have throws, so a renamed column fails loudly. */
function readCsv(file: string): { get(column: string): string }[] {
  const [header, ...rows] = parseCsv(readFileSync(path.join(DATA_DIR, file), "utf8"));
  if (!header) throw new Error(`${file} is empty`);
  return rows.map((r) => ({
    get(column: string) {
      const i = header.indexOf(column);
      if (i < 0) throw new Error(`${file} has no column "${column}"`);
      return r[i] ?? "";
    },
  }));
}

export type Option = { value: string; label: string };

export function listDepartments(): Option[] {
  return readCsv("departments.csv").map((d) => ({ value: d.get("department_id"), label: d.get("name") }));
}

export function listTaxCodes(): Option[] {
  return readCsv("tax_codes.csv").map((t) => ({ value: t.get("code"), label: t.get("description") }));
}
