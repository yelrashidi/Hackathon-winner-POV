import type { Flag } from "@/contracts/flag";
import type { RemitTo } from "@/contracts/validation";
import { VALIDATION_CONFIG } from "../config";
import type { BankAccountVersion } from "../context";
import { makeFlag } from "../flag";
import { daysBetween } from "../lib/dates";
import { digitsOnly } from "../lib/text";
import type { Rule } from "./types";

/**
 * Remit-to bank details against the vendor's VERIFIED account (a change needs a second person,
 * feature 9). The classic fraud is "we changed banks, pay this new account": an invoice that
 * remits to an unverified or unknown account is blocked. Payments (7) re-runs this at release.
 */
export const bankRule: Rule = (input, ctx, d) => {
  const flags: Flag[] = [];
  if (!d.vendor) return flags;
  const v = d.vendor;
  const versions = ctx.bankAccounts.filter((a) => a.vendorId === v.id).sort((a, b) => b.version - a.version);
  const verified = versions.find((a) => a.status === "verified") ?? null;
  const pending = versions.filter((a) => a.status === "pending");
  const remit = input.remitTo && input.remitTo.account ? input.remitTo : null;

  if (remit) {
    const pendingHit = pending.find((p) => sameAccount(remit, p));
    if (pendingHit) {
      flags.push(
        makeFlag(
          "BANK_ACCOUNT_UNVERIFIED",
          `Remit-to account ••${last4(remit.account!)} is the bank change requested ${pendingHit.changedAt ?? "recently"}${pendingHit.channel ? ` by ${pendingHit.channel.replace(/_/g, " ")}` : ""} and not yet verified by a second person${verified ? ` (verified account on file: ••${verified.last4})` : ""}`,
          { field: "remitTo", actual: `••${last4(remit.account!)}`, expected: verified ? `••${verified.last4}` : null, changedAt: pendingHit.changedAt, channel: pendingHit.channel, source: `vendor bank accounts ${v.id}` },
        ),
      );
    } else if (!verified || !sameAccount(remit, verified)) {
      flags.push(
        makeFlag(
          "BANK_DETAILS_MISMATCH",
          verified
            ? `Remit-to account ••${last4(remit.account!)}${remit.institution ? ` (inst ${remit.institution}, transit ${remit.transit ?? "?"})` : ""} differs from ${v.legalName}'s verified account ••${verified.last4} — do not pay until the vendor's bank details are verified`
            : `Remit-to account ••${last4(remit.account!)} but ${v.legalName} has no verified bank account on file — verify before paying`,
          { field: "remitTo", actual: `••${last4(remit.account!)}`, expected: verified ? `••${verified.last4}` : null, source: `vendor bank accounts ${v.id}` },
        ),
      );
    }
  }

  // A verified change shortly before this invoice: legitimate, but worth a second look.
  if (verified?.changedAt && input.invoiceDate && (!remit || sameAccount(remit, verified))) {
    const days = daysBetween(verified.changedAt, input.invoiceDate);
    if (days >= 0 && days <= VALIDATION_CONFIG.bankRecentDays) {
      flags.push(
        makeFlag(
          "BANK_RECENTLY_CHANGED",
          `${v.legalName}'s bank account changed ${days} day${days === 1 ? "" : "s"} before this invoice (${verified.changedAt}${verified.channel ? `, ${verified.channel.replace(/_/g, " ")}` : ""})`,
          { field: "remitTo", changedAt: verified.changedAt, channel: verified.channel, source: `vendor bank accounts ${v.id}` },
        ),
      );
    }
  }
  return flags;
};

function last4(account: string): string {
  return digitsOnly(account).slice(-4);
}

/** Full account numbers compared in full (plus institution/transit when both sides have them); else last 4 digits. */
export function sameAccount(remit: RemitTo, version: BankAccountVersion): boolean {
  const r = digitsOnly(remit.account ?? "");
  if (!r) return false;
  if (version.account) {
    if (r !== digitsOnly(version.account)) return false;
    if (remit.institution && version.institution && digitsOnly(remit.institution) !== digitsOnly(version.institution)) return false;
    if (remit.transit && version.transit && digitsOnly(remit.transit) !== digitsOnly(version.transit)) return false;
    return true;
  }
  return r.slice(-4) === version.last4;
}
