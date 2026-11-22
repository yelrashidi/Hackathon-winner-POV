import { readFileSync } from "node:fs";
import path from "node:path";

export const DATASET_DIR = path.resolve("brim_ap_dataset/brim_ap_dataset");

/**
 * Vendor AP-contact domains from the dataset's vendors.csv — the "known sender" list the intake
 * rules use until the vendors table exists (step 3 swaps this for a DB query). Only the e-mail
 * addresses are needed, so no CSV parsing: every address in the file is a vendor contact.
 */
export function vendorDomainsFromCsv(file = path.join(DATASET_DIR, "data/vendors.csv")): Set<string> {
  const text = readFileSync(file, "utf8");
  const domains = new Set<string>();
  for (const m of text.matchAll(/[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g)) domains.add(m[1]!.toLowerCase());
  return domains;
}
