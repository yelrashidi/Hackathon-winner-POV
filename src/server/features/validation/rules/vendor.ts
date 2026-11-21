import type { Flag } from "@/contracts/flag";
import { VALIDATION_CONFIG } from "../config";
import type { BankAccountVersion, ValidationContext, VendorRef } from "../context";
import { makeFlag } from "../flag";
import { coreName, digitsOnly, editDistance, emailDomain, lightName, trigramSimilarity } from "../lib/text";
import type { Rule } from "./types";

/**
 * Vendor master: known, active, and not an impostor record.
 *
 * VENDOR_LOOKALIKE fires when the matched vendor resembles ANOTHER vendor that is more
 * established (more invoices on record): near-identical name, near-identical or identical email
 * domain, or the same bank account. "More established" is what tells the copy from the original:
 * the real Polar Freight has 12 invoices, the "Polar Freight Lines Limited" record 3. Onboarding
 * dates cannot tell them apart (an impostor record can be old). Also fires when the sender's
 * domain is one or two characters away from a known vendor's domain (speedytlres vs speedytires).
 */
export const vendorRule: Rule = (input, ctx, d) => {
  const flags: Flag[] = [];
  const m = d.vendorMatch;
  const printed = input.vendor.nameRaw ?? "Vendor";

  if (!d.vendor) {
    const closest = m.candidates.length
      ? ` Closest in the vendor master: ${m.candidates.map((c) => `${c.legalName} (${c.vendorId}, ${Math.round(c.similarity * 100)}% similar)`).join("; ")}.`
      : "";
    flags.push(
      makeFlag(
        "VENDOR_UNKNOWN",
        `"${printed}" is not in the vendor master (no match by GST/HST number, name or email domain) — onboard the vendor before approval.${closest}`,
        { field: "vendor", actual: printed, candidates: m.candidates, source: "vendor master" },
      ),
    );
    const sender = senderLookalike(input.senderEmail, null, ctx.vendors);
    if (sender) flags.push(sender);
    return flags;
  }

  const v = d.vendor;
  if (v.status !== "active") {
    const effect =
      v.status === "pending_review"
        ? "approvals adds a finance-manager review"
        : v.status === "on_hold"
          ? "approvals holds the invoice"
          : "it cannot be paid until reactivated";
    flags.push(
      makeFlag("VENDOR_NOT_ACTIVE", `Vendor ${v.legalName} (${v.id}) is ${v.status.replace(/_/g, " ")} — ${effect}`, {
        field: "vendor",
        actual: v.status,
        expected: "active",
        source: `vendor master ${v.id}`,
      }),
    );
  }

  const look = lookalikeOf(v, ctx);
  if (look.length > 0) {
    const parts = look.map((l) => `${l.other.legalName} (${l.other.id}, ${l.other.invoiceCount} invoices): ${l.reasons.join(", ")}`);
    flags.push(
      makeFlag(
        "VENDOR_LOOKALIKE",
        `${v.legalName} (${v.id}, ${v.invoiceCount} invoice${v.invoiceCount === 1 ? "" : "s"} on record) resembles ${parts.join("; ")} — possible impersonation; confirm the vendor before paying`,
        {
          field: "vendor",
          actual: v.id,
          resembles: look.map((l) => ({ vendorId: l.other.id, legalName: l.other.legalName, reasons: l.reasons })),
          source: "vendor master",
        },
      ),
    );
  } else {
    const sender = senderLookalike(input.senderEmail, v, ctx.vendors);
    if (sender) flags.push(sender);
  }

  if ((m.method === "tax_number" || m.method === "email_domain") && input.vendor.nameRaw && lightName(input.vendor.nameRaw) !== lightName(v.legalName)) {
    flags.push(
      makeFlag(
        "VENDOR_NAME_MISMATCH",
        `Matched to ${v.legalName} (${v.id}) by ${m.method === "tax_number" ? "tax registration number" : "email domain"}; the invoice prints "${input.vendor.nameRaw}"`,
        { field: "vendor.nameRaw", actual: input.vendor.nameRaw, expected: v.legalName, source: `vendor master ${v.id}` },
      ),
    );
  }

  return flags;
};

interface Lookalike {
  other: VendorRef;
  reasons: string[];
}

/** vendorId → digits of its latest live (verified or pending) full account number. One pass. */
function currentAccounts(accounts: readonly BankAccountVersion[]): Map<string, string> {
  const best = new Map<string, BankAccountVersion>();
  for (const a of accounts) {
    if (a.status === "superseded" || a.status === "rejected" || !a.account) continue;
    const prev = best.get(a.vendorId);
    if (!prev || a.version > prev.version) best.set(a.vendorId, a);
  }
  return new Map([...best].map(([id, a]) => [id, digitsOnly(a.account!)]));
}

export function lookalikeOf(v: VendorRef, ctx: ValidationContext): Lookalike[] {
  const out: Lookalike[] = [];
  const myCore = coreName(v.legalName);
  const myDomain = emailDomain(v.contactEmail);
  const accounts = currentAccounts(ctx.bankAccounts);
  const myAccount = accounts.get(v.id) ?? null;
  for (const o of ctx.vendors) {
    if (o.id === v.id || o.invoiceCount < v.invoiceCount) continue; // only resembling a more (or equally) established record
    if (o.invoiceCount === v.invoiceCount && o.invoiceCount > 0) continue; // two equally used records: no copy/original
    const reasons: string[] = [];
    const sim = trigramSimilarity(myCore, coreName(o.legalName));
    if (sim >= VALIDATION_CONFIG.lookalikeNameSimilarity) reasons.push(`name ${Math.round(sim * 100)}% similar`);
    const oDomain = emailDomain(o.contactEmail);
    if (myDomain && oDomain) {
      if (myDomain === oDomain) reasons.push(`same email domain ${myDomain}`);
      else if (editDistance(myDomain, oDomain) <= VALIDATION_CONFIG.lookalikeDomainDistance) reasons.push(`email domain ${myDomain} vs ${oDomain}`);
    }
    const oAccount = accounts.get(o.id) ?? null;
    if (myAccount && oAccount && myAccount === oAccount) reasons.push(`same bank account ••${myAccount.slice(-4)}`);
    if (reasons.length > 0) out.push({ other: o, reasons });
  }
  return out;
}

/** Sender domain one or two characters away from a known vendor's domain (but not equal to the matched vendor's). */
function senderLookalike(senderEmail: string | null, matched: VendorRef | null, vendors: readonly VendorRef[]): Flag | null {
  const sender = emailDomain(senderEmail);
  if (!sender) return null;
  if (matched && emailDomain(matched.contactEmail) === sender) return null;
  if (vendors.some((v) => emailDomain(v.contactEmail) === sender)) return null; // a known domain
  let best: { v: VendorRef; dist: number } | null = null;
  for (const v of vendors) {
    const dom = emailDomain(v.contactEmail);
    if (!dom) continue;
    const dist = editDistance(sender, dom);
    if (dist >= 1 && dist <= VALIDATION_CONFIG.lookalikeDomainDistance && (!best || dist < best.dist)) best = { v, dist };
  }
  if (!best) return null;
  return makeFlag(
    "VENDOR_LOOKALIKE",
    `Sent from ${sender}, ${best.dist} character${best.dist === 1 ? "" : "s"} away from ${best.v.legalName}'s domain ${emailDomain(best.v.contactEmail)} — possible lookalike sender; confirm before paying`,
    { field: "senderEmail", actual: sender, expected: emailDomain(best.v.contactEmail), resembles: [{ vendorId: best.v.id, legalName: best.v.legalName }] },
  );
}
