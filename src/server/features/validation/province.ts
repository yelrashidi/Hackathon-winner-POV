import type { ValidationInput } from "@/contracts/validation";
import type { Office } from "./context";
import { stripAccents } from "./lib/text";

/**
 * Province of delivery (place of supply), which decides the tax. Never the vendor's address.
 * Order: an explicit ship-to province → the bill-to province → a province code in the bill-to
 * address → a Harborline office matched by postal prefix or city → unknown (never a guess).
 */

export const CANADIAN_PROVINCES = new Set([
  "AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT",
]);

export type ProvinceSource = "ship_to" | "bill_to" | "bill_to_address" | "office" | null;

export interface ProvinceResolution {
  province: string | null;
  source: ProvinceSource;
}

const ADDRESS_PROVINCE = /\b(AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)\b[\s,]+([A-Z]\d[A-Z])\s?\d[A-Z]\d\b/i;

function valid(p: string | null | undefined): string | null {
  const up = p?.trim().toUpperCase();
  return up && CANADIAN_PROVINCES.has(up) ? up : null;
}

export function resolveDeliveryProvince(
  input: Pick<ValidationInput, "shipToProvince" | "billTo">,
  offices: readonly Office[],
): ProvinceResolution {
  const ship = valid(input.shipToProvince);
  if (ship) return { province: ship, source: "ship_to" };

  const bill = valid(input.billTo.province);
  if (bill) return { province: bill, source: "bill_to" };

  const address = input.billTo.address;
  if (address) {
    const m = ADDRESS_PROVINCE.exec(address);
    if (m) return { province: m[1]!.toUpperCase(), source: "bill_to_address" };

    const upper = stripAccents(address).toUpperCase();
    for (const o of offices) {
      const prefix = o.postalPrefix.toUpperCase();
      const cityRe = new RegExp(`\\b${stripAccents(o.city).toUpperCase()}\\b`);
      if ((prefix && new RegExp(`\\b${prefix}\\s?\\d[A-Z]\\d\\b`).test(upper)) || cityRe.test(upper)) {
        return { province: o.province, source: "office" };
      }
    }
  }
  return { province: null, source: null };
}
