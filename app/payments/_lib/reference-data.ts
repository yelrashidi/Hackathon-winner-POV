import "server-only";

// TEMP: departments and tax codes read straight from the dataset CSVs until the foundation's
// tables exist. Used by the upload form's dropdowns.

import { readFileSync } from "node:fs";
import path from "node:path";
import { parseCsv } from "@/server/session/users";

const DATA_DIR = path.join(process.cwd(), "brim_ap_dataset/brim_ap_dataset/data");

function readCsv(file: string): Record<string, string>[] {
  const [header = [], ...rows] = parseCsv(readFileSync(path.join(DATA_DIR, file), "utf8"));
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

export type Option = { value: string; label: string };

export function listDepartments(): Option[] {
  return readCsv("departments.csv").map((d) => ({ value: d.department_id ?? "", label: d.name ?? "" }));
}

export function listTaxCodes(): Option[] {
  return readCsv("tax_codes.csv").map((t) => ({ value: t.code ?? "", label: t.description ?? "" }));
}
