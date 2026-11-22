import type { Flag } from "@/contracts/flag";
import type { ValidationInput } from "@/contracts/validation";
import { VALIDATION_CONFIG } from "../config";
import type { TaxCodeRef } from "../context";
import type { Derived } from "../derive";
import { makeFlag } from "../flag";
import { formatMoney, formatRateAsPercent, mulRate } from "../lib/money";
import { normalizeTaxNumber } from "../lib/text";
import { familyOf, goodsOnly, inferTaxCode, isZeroRate, PROVINCE_TAX_CODES, shortTaxLabel } from "../tax-expectations";
import type { Rule } from "./types";

/**
 * Tax against the province of DELIVERY (dataset README: place of supply), never the vendor's
 * address. Rates come from tax_codes; which codes a province needs comes from tax-expectations.
 *
 * Order (each step can end the check, so one problem gives one flag):
 *   registration numbers → unmapped tax lines → foreign vendor → exempt supply →
 *   unregistered small supplier → province known? → expected vs charged codes →
 *   BC PST on services → amounts (and QST compounded on GST).
 */

const GST_FORMAT = /^\d{9}RT\d{4}$/;
const QST_FORMAT = /^\d{10}TQ\d{4}$/;

interface Charged {
  code: string;
  ref: TaxCodeRef;
  amountCents: number;
}

export const taxRule: Rule = (input, ctx, d) => {
  const flags: Flag[] = [];
  const cur = d.currency;
  const tol = VALIDATION_CONFIG.centsTolerancePerLine;
  const codeRef = new Map(ctx.taxCodes.map((t) => [t.code, t]));

  // ---- charged taxes, by code -----------------------------------------------------------------
  // A line with no code gets one only if its label AND printed rate match exactly one tax code
  // ("TVH (13 %)" → HST13). Anything still unmapped is reported, and while it exists nothing is
  // reported as MISSING: the unmapped line may well be that tax.
  const charged = new Map<string, Charged>();
  let unmapped = 0;
  for (const t of input.taxes) {
    const ref = t.code ? codeRef.get(t.code) : inferTaxCode(t.label, t.ratePct, ctx.taxCodes) ?? undefined;
    if (!ref) {
      if (t.amountCents !== 0) {
        unmapped++;
        flags.push(
          makeFlag(
            "TAX_CODE_UNKNOWN",
            `Tax line "${t.label}" (${formatMoney(t.amountCents, cur)}) is not a known tax code${t.code ? ` (${t.code})` : ""}; it was not checked, and no tax is reported missing until it is mapped`,
            { field: "taxes", actual: t.code ?? t.label, source: "tax_codes" },
          ),
        );
      }
      continue;
    }
    if (t.amountCents === 0) continue;
    const prev = charged.get(ref.code);
    charged.set(ref.code, { code: ref.code, ref, amountCents: (prev?.amountCents ?? 0) + t.amountCents });
  }
  const chargedByFamily = (fam: string) => [...charged.values()].filter((c) => familyOf(c.code) === fam);
  const describeCharged = (list: Charged[]) =>
    list.length === 0 ? "no tax" : list.map((c) => `${shortTaxLabel(c.ref)} (${formatMoney(c.amountCents, cur)})`).join(" + ");

  // ---- registration numbers ------------------------------------------------------------------
  const invGst = input.vendor.gstHstNumber ? normalizeTaxNumber(input.vendor.gstHstNumber) : null;
  const invQst = input.vendor.qstNumber ? normalizeTaxNumber(input.vendor.qstNumber) : null;
  const masterGst = d.vendor?.gstHstNumber ? normalizeTaxNumber(d.vendor.gstHstNumber) : null;
  const masterQst = d.vendor?.qstNumber ? normalizeTaxNumber(d.vendor.qstNumber) : null;

  if (invGst && !GST_FORMAT.test(invGst)) {
    flags.push(
      makeFlag("TAX_NUMBER_INVALID", `GST/HST number "${input.vendor.gstHstNumber}" is not a valid business number (9 digits + RT + 4 digits)`, {
        field: "vendor.gstHstNumber",
        actual: input.vendor.gstHstNumber,
        expected: "#########RT####",
      }),
    );
  }
  if (invQst && !QST_FORMAT.test(invQst)) {
    flags.push(
      makeFlag("TAX_NUMBER_INVALID", `QST number "${input.vendor.qstNumber}" is not a valid QST number (10 digits + TQ + 4 digits)`, {
        field: "vendor.qstNumber",
        actual: input.vendor.qstNumber,
        expected: "##########TQ####",
      }),
    );
  }
  if (d.vendor && invGst && masterGst && invGst !== masterGst) {
    flags.push(
      makeFlag("TAX_NUMBER_MISMATCH", `GST/HST number on the invoice ${invGst} differs from the vendor master ${masterGst} (${d.vendor.legalName})`, {
        field: "vendor.gstHstNumber",
        actual: invGst,
        expected: masterGst,
        source: `vendor master ${d.vendor.id}`,
      }),
    );
  }
  if (d.vendor && invQst && masterQst && invQst !== masterQst) {
    flags.push(
      makeFlag("TAX_NUMBER_MISMATCH", `QST number on the invoice ${invQst} differs from the vendor master ${masterQst} (${d.vendor.legalName})`, {
        field: "vendor.qstNumber",
        actual: invQst,
        expected: masterQst,
        source: `vendor master ${d.vendor.id}`,
      }),
    );
  }
  const gstCharged = chargedByFamily("gst_hst");
  if (gstCharged.length > 0 && !invGst && !masterGst) {
    flags.push(
      makeFlag(
        "TAX_NUMBER_MISSING",
        `${describeCharged(gstCharged)} charged, but there is no GST/HST registration number on the invoice or in the vendor master — no input tax credit can be claimed`,
        { field: "vendor.gstHstNumber", actualCents: gstCharged.reduce((s, c) => s + c.amountCents, 0) },
      ),
    );
  }
  const qstCharged = chargedByFamily("qst");
  if (qstCharged.length > 0 && !invQst && !masterQst) {
    flags.push(
      makeFlag(
        "QST_NUMBER_MISSING",
        `${describeCharged(qstCharged)} charged without a QST registration number on the invoice or in the vendor master; the QST refund needs it`,
        { field: "vendor.qstNumber", actualCents: qstCharged.reduce((s, c) => s + c.amountCents, 0) },
      ),
    );
  }

  // Nothing to compute a base from: arithmetic/completeness already said so.
  if (d.subtotalCents === null) return flags;

  // ---- foreign vendor ------------------------------------------------------------------------
  const country = (d.vendor?.country ?? input.vendor.country)?.toUpperCase() ?? null;
  if (country && country !== "CA") {
    if (charged.size > 0) {
      flags.push(
        makeFlag("TAX_FOREIGN_VENDOR", `Vendor is in ${country} but charged Canadian tax: ${describeCharged([...charged.values()])}; foreign vendors normally charge none`, {
          field: "taxes",
          actual: [...charged.keys()],
          expected: [],
          source: d.vendor ? `vendor master ${d.vendor.id}` : "invoice address",
        }),
      );
    }
    return flags;
  }
  if (input.taxes.some((t) => t.code === "FOREIGN")) {
    flags.push(
      makeFlag("TAX_FOREIGN_VENDOR", `A Canadian vendor used the FOREIGN (no tax) code; Canadian suppliers charge GST/HST`, {
        field: "taxes",
        actual: "FOREIGN",
      }),
    );
  }

  // ---- exempt supply -------------------------------------------------------------------------
  const exemptByInvoice = input.taxes.some((t) => {
    const ref = t.code ? codeRef.get(t.code) : undefined;
    return t.code === "EXEMPT" && ref !== undefined && isZeroRate(ref);
  });
  const history = d.vendorPrior.filter((p) => !p.isCreditNote && p.taxCodes.length > 0);
  const exemptByHistory = history.length >= 2 && history.every((p) => p.taxCodes.every((c) => c === "EXEMPT"));
  if (exemptByInvoice || exemptByHistory) {
    if (charged.size > 0) {
      const why = exemptByInvoice
        ? "the invoice marks the supply exempt"
        : `all ${history.length} earlier invoices from ${d.vendor!.legalName} were exempt`;
      flags.push(
        makeFlag("TAX_ON_EXEMPT", `Tax charged on an exempt supply (${why}): ${describeCharged([...charged.values()])}`, {
          field: "taxes",
          actual: [...charged.keys()],
          expected: ["EXEMPT"],
          source: exemptByInvoice ? "invoice" : "vendor history",
        }),
      );
    }
    return flags;
  }

  // ---- unregistered small supplier -----------------------------------------------------------
  if (!invGst && !masterGst && charged.size === 0 && unmapped === 0) {
    flags.push(
      makeFlag(
        "VENDOR_NOT_TAX_REGISTERED",
        `${d.vendor?.legalName ?? input.vendor.nameRaw ?? "Vendor"} has no GST/HST registration number and charged no tax (small supplier) — nothing to recover`,
        { field: "vendor.gstHstNumber", source: d.vendor ? `vendor master ${d.vendor.id}` : "invoice" },
      ),
    );
    return flags;
  }

  // ---- province of delivery ------------------------------------------------------------------
  const province = d.province.province;
  if (!province) {
    flags.push(
      makeFlag("TAX_PROVINCE_UNKNOWN", "Delivery province could not be determined from the ship-to or bill-to address — tax was not checked", {
        field: "shipToProvince",
      }),
    );
    return flags;
  }
  const expectedCodes = PROVINCE_TAX_CODES[province];
  if (!expectedCodes) {
    flags.push(
      makeFlag("TAX_PROVINCE_UNKNOWN", `No tax rule configured for deliveries to ${province} — tax was not checked`, {
        field: "shipToProvince",
        actual: province,
      }),
    );
    return flags;
  }

  return flags.concat(checkProvinceTaxes(input, d, province, expectedCodes, codeRef, charged, unmapped > 0, tol, cur));
};

function checkProvinceTaxes(
  input: ValidationInput,
  d: Derived,
  province: string,
  expectedCodes: readonly string[],
  codeRef: Map<string, TaxCodeRef>,
  charged: Map<string, Charged>,
  hasUnmapped: boolean,
  tol: number,
  cur: string | null,
): Flag[] {
  const flags: Flag[] = [];
  const allBase = d.subtotalCents!;
  const allLines = Math.max(1, input.lines.length);
  const goodsLines = input.lines.filter((l) => l.lineType === "goods");
  const unknownType = input.lines.filter((l) => l.lineType === null);
  const goodsBase = unknownType.length > 0 ? null : goodsLines.reduce((s, l) => s + l.amountCents, 0);
  const evidenceBase = { province, provinceSource: d.province.source, source: "tax_codes" };

  // Expected codes with their base; codes missing from tax_codes are skipped, never assumed.
  const expected = new Map<string, { ref: TaxCodeRef; baseCents: number; lines: number }>();
  const skipped = new Set<string>();
  for (const code of expectedCodes) {
    const ref = codeRef.get(code);
    if (!ref) continue;
    if (goodsOnly(ref)) {
      if (goodsBase === null) {
        skipped.add(code);
        flags.push(
          makeFlag(
            "LINE_TYPE_UNKNOWN",
            `Line${unknownType.length > 1 ? "s" : ""} ${unknownType.map((l) => l.lineNo).join(", ")} not marked goods or services, so ${shortTaxLabel(ref)} (goods only) could not be checked for delivery to ${province}`,
            { field: "lines.lineType", lineNo: unknownType[0]!.lineNo, ...evidenceBase },
          ),
        );
        continue;
      }
      if (goodsBase !== 0) expected.set(code, { ref, baseCents: goodsBase, lines: Math.max(1, goodsLines.length) });
    } else if (allBase !== 0) {
      expected.set(code, { ref, baseCents: allBase, lines: allLines });
    }
  }

  // BC PST (any goods-only code the province uses) charged beyond the goods lines.
  const handled = new Set<string>();
  for (const c of charged.values()) {
    if (!goodsOnly(c.ref) || !expectedCodes.includes(c.code)) continue;
    if (skipped.has(c.code)) {
      handled.add(c.code);
      continue;
    }
    const goods = goodsBase ?? 0;
    const allowed = mulRate(goods, c.ref.rate);
    const tolerance = tol * Math.max(1, goodsLines.length);
    if (Math.abs(c.amountCents) > Math.abs(allowed) + tolerance) {
      handled.add(c.code);
      const services = input.lines.filter((l) => l.lineType === "services").map((l) => l.lineNo);
      flags.push(
        makeFlag(
          "TAX_PST_ON_SERVICES",
          `${shortTaxLabel(c.ref)} ${formatMoney(c.amountCents, cur)} charged, but only ${formatMoney(goods, cur)} of the lines are goods (expected ${formatMoney(allowed, cur)}); PST applies to goods only — services line${services.length === 1 ? "" : "s"} ${services.join(", ")}`,
          { field: "taxes", expectedCents: allowed, actualCents: c.amountCents, taxCode: c.code, ...evidenceBase },
        ),
      );
    }
  }

  // A code already reported as PST-on-services is settled: it is neither "missing" nor "unexpected".
  const chargedCodes = [...charged.keys()].filter((c) => !handled.has(c));
  const expectedSet = new Set([...expected.keys()].filter((c) => !handled.has(c)));

  // Nothing charged at all on a taxable supply (an unmapped tax line might be it: don't claim that).
  if (charged.size === 0 && expectedSet.size > 0 && !hasUnmapped) {
    const exp = [...expected.values()];
    flags.push(
      makeFlag(
        "TAX_MISSING",
        `No tax charged on a ${formatMoney(allBase, cur)} supply delivered to ${province}; expected ${exp.map((e) => `${shortTaxLabel(e.ref)} (${formatMoney(mulRate(e.baseCents, e.ref.rate), cur)})`).join(" + ")}`,
        { field: "taxes", expected: [...expectedSet], actual: [], ...evidenceBase },
      ),
    );
    return flags;
  }

  // Expected vs charged codes.
  const missing = hasUnmapped ? [] : [...expectedSet].filter((c) => !chargedCodes.includes(c));
  const unexpected = chargedCodes.filter((c) => !expectedSet.has(c));
  if (missing.length > 0 || unexpected.length > 0) {
    const expText = expectedSet.size ? [...expected.values()].map((e) => shortTaxLabel(e.ref)).join(" + ") : "no tax";
    const chText = describeList(chargedCodes.map((c) => charged.get(c)!), cur);
    const detail: string[] = [];
    if (missing.length) {
      detail.push(
        `missing ${missing.map((c) => { const e = expected.get(c)!; return `${shortTaxLabel(e.ref)} (${formatMoney(mulRate(e.baseCents, e.ref.rate), cur)})`; }).join(", ")}`,
      );
    }
    if (unexpected.length) detail.push(`not applicable: ${unexpected.map((c) => shortTaxLabel(charged.get(c)!.ref)).join(", ")}`);
    flags.push(
      makeFlag("TAX_PROVINCE_MISMATCH", `Delivery to ${province} expects ${expText}; invoice charges ${chText} (${detail.join("; ")})`, {
        field: "taxes",
        expected: [...expectedSet],
        actual: chargedCodes,
        missing,
        unexpected,
        ...evidenceBase,
      }),
    );
  }

  // Amounts for codes that are both expected and charged.
  for (const code of chargedCodes) {
    const e = expected.get(code);
    if (!e) continue;
    const c = charged.get(code)!;
    const want = mulRate(e.baseCents, e.ref.rate);
    const tolerance = tol * e.lines;
    if (Math.abs(c.amountCents - want) <= tolerance) continue;
    if (familyOf(code) === "qst") {
      const gst = [...charged.values()].filter((x) => familyOf(x.code) === "gst_hst").reduce((s, x) => s + x.amountCents, 0);
      const compounded = mulRate(e.baseCents + gst, e.ref.rate);
      if (gst !== 0 && Math.abs(c.amountCents - compounded) <= tolerance) {
        flags.push(
          makeFlag(
            "TAX_QST_COMPOUNDED",
            `${shortTaxLabel(e.ref)} ${formatMoney(c.amountCents, cur)} was computed on subtotal + GST (${formatMoney(e.baseCents + gst, cur)}); QST applies to the pre-tax ${formatMoney(e.baseCents, cur)} only (expected ${formatMoney(want, cur)})`,
            { field: "taxes", taxCode: code, expectedCents: want, actualCents: c.amountCents, ...evidenceBase },
          ),
        );
        continue;
      }
    }
    flags.push(
      makeFlag(
        "TAX_AMOUNT_MISMATCH",
        `${shortTaxLabel(e.ref)} should be ${formatMoney(want, cur)} (${formatRateAsPercent(e.ref.rate)} of ${formatMoney(e.baseCents, cur)}); the invoice shows ${formatMoney(c.amountCents, cur)}`,
        { field: "taxes", taxCode: code, expectedCents: want, actualCents: c.amountCents, ...evidenceBase },
      ),
    );
  }

  return flags;
}

function describeList(list: Charged[], cur: string | null): string {
  return list.length === 0 ? "no applicable tax" : list.map((c) => `${shortTaxLabel(c.ref)} (${formatMoney(c.amountCents, cur)})`).join(" + ");
}
