import type { VendorReason, VendorStatus } from "@/contracts/vendor";
import { VALIDATION_CONFIG } from "@/server/features/validation/config";
import { coreName, emailDomain, lightName, normalizeTaxNumber, trigramSimilarity } from "@/server/features/validation/lib/text";

/**
 * Feature 9's decisions, as pure functions: data in → reasons out. An empty list means "allowed".
 * No database here, so every rule is a one-line test and easy to explain in the Q&A.
 *
 * Who may press which button BY ROLE is `authorize()` (src/server/core/authorize.ts). These rules
 * add what needs data: the state the vendor is in, and the "two people" controls —
 *   - whoever onboarded a vendor cannot approve it          (ONBOARDED_IT)
 *   - whoever entered bank details cannot verify them        (ENTERED_IT; also a DB CHECK)
 *
 * Bank reason codes and messages match payments' checks (features/payments/rules.ts), so both
 * screens say the same thing. Each reason carries the HTTP status the service answers with.
 */

export interface Reason extends VendorReason {
  /** 400 bad input · 403 not allowed for this person · 409 wrong state right now */
  status: 400 | 403 | 409;
  /** The existing vendor a duplicate / similarity reason is about. */
  vendorId?: string;
}

const reason = (status: Reason["status"], code: string, message: string, vendorId?: string): Reason => (vendorId ? { status, code, message, vendorId } : { status, code, message });

// ---------------------------------------------------------------------------------------------
// The person acting
// ---------------------------------------------------------------------------------------------

/** People on leave or terminated keep their role in the table, but cannot act. */
export function checkActorActive(actor: { fullName: string; status: string } | undefined): Reason[] {
  if (!actor) return [reason(403, "UNKNOWN_USER", "You are not a known user.")];
  if (actor.status !== "active") return [reason(403, "USER_NOT_ACTIVE", `${actor.fullName} is ${actor.status.replace(/_/g, " ")} and cannot act.`)];
  return [];
}

// ---------------------------------------------------------------------------------------------
// Onboarding: is this vendor already in the master?
// ---------------------------------------------------------------------------------------------

export interface ExistingVendor {
  id: string;
  legalName: string;
  gstHstNumber: string | null;
  qstNumber: string | null;
  apContactEmail: string | null;
}

export interface NewVendorKeys {
  legalName: string;
  gstHstNumber: string | null;
  qstNumber: string | null;
  apContactEmail: string | null;
}

/** Free mail providers say nothing about who the vendor is. */
const GENERIC_DOMAINS = new Set(["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "live.com", "proton.me", "protonmail.com"]);

/**
 * Same tax number or same legal name → refuse (it is the same vendor; adding it twice is how fake
 * vendors and double payments start). Same email domain or a similar name → warn only.
 * Uses validation's own normalisers, so "already exists" means what invoice matching means.
 */
export function findExistingVendor(v: NewVendorKeys, existing: readonly ExistingVendor[]): { refusals: Reason[]; warnings: Reason[] } {
  const refusals: Reason[] = [];
  const warnings: Reason[] = [];
  const name = (e: ExistingVendor) => `${e.legalName} (${e.id})`;

  const gst = v.gstHstNumber ? normalizeTaxNumber(v.gstHstNumber) : null;
  const qst = v.qstNumber ? normalizeTaxNumber(v.qstNumber) : null;
  for (const e of existing) {
    if (gst && e.gstHstNumber && normalizeTaxNumber(e.gstHstNumber) === gst) {
      refusals.push(reason(409, "VENDOR_ALREADY_EXISTS", `GST/HST number ${v.gstHstNumber} already belongs to ${name(e)}.`, e.id));
    } else if (gst && e.gstHstNumber && /^\d{9}/.test(gst) && normalizeTaxNumber(e.gstHstNumber).slice(0, 9) === gst.slice(0, 9)) {
      refusals.push(reason(409, "VENDOR_ALREADY_EXISTS", `Business number ${gst.slice(0, 9)} already belongs to ${name(e)}.`, e.id));
    } else if (qst && e.qstNumber && normalizeTaxNumber(e.qstNumber) === qst) {
      refusals.push(reason(409, "VENDOR_ALREADY_EXISTS", `QST number ${v.qstNumber} already belongs to ${name(e)}.`, e.id));
    } else if (lightName(e.legalName) === lightName(v.legalName)) {
      refusals.push(reason(409, "VENDOR_ALREADY_EXISTS", `${name(e)} already has this legal name.`, e.id));
    }
  }
  if (refusals.length) return { refusals, warnings };

  const domain = emailDomain(v.apContactEmail);
  if (domain && !GENERIC_DOMAINS.has(domain)) {
    for (const e of existing) {
      if (emailDomain(e.apContactEmail) === domain) warnings.push(reason(409, "EMAIL_DOMAIN_IN_USE", `${name(e)} already uses the email domain ${domain}.`, e.id));
    }
  }
  const core = coreName(v.legalName);
  for (const e of existing) {
    const similarity = trigramSimilarity(core, coreName(e.legalName));
    if (similarity >= VALIDATION_CONFIG.candidateNameSimilarity) {
      warnings.push(reason(409, "SIMILAR_VENDOR_NAME", `The name looks like ${name(e)} (${Math.round(similarity * 100)}% similar) — check it is not the same company.`, e.id));
    }
  }
  return { refusals, warnings };
}

// ---------------------------------------------------------------------------------------------
// Status changes
// ---------------------------------------------------------------------------------------------

export interface VendorState {
  id: string;
  legalName: string;
  status: VendorStatus;
  /** From the audit trail; null for vendors that came with the dataset. */
  onboardedBy: string | null;
}

/** pending_review → active. A second person: not whoever onboarded it. */
export function checkApprove(v: VendorState, actor: { id: string; fullName: string }): Reason[] {
  if (v.status !== "pending_review") return [reason(409, "NOT_PENDING_REVIEW", `${v.legalName} is ${label(v.status)}; only a vendor pending review can be approved.`)];
  if (v.onboardedBy === actor.id) return [reason(403, "ONBOARDED_IT", `${actor.fullName} onboarded ${v.legalName}, so a second person must approve it.`)];
  return [];
}

/** active | pending_review → on_hold. Anyone in finance may stop a vendor; a reason is required. */
export function checkHold(v: VendorState, why: string): Reason[] {
  const out: Reason[] = [];
  if (v.status === "on_hold") out.push(reason(409, "ALREADY_ON_HOLD", `${v.legalName} is already on hold.`));
  if (!why.trim()) out.push(reason(400, "REASON_REQUIRED", "Give a reason for the hold; it is kept in the audit trail."));
  return out;
}

/** on_hold → the status it had before the hold (a never-approved vendor goes back to pending review). */
export function checkReleaseHold(v: VendorState, why: string): Reason[] {
  const out: Reason[] = [];
  if (v.status !== "on_hold") out.push(reason(409, "NOT_ON_HOLD", `${v.legalName} is ${label(v.status)}, not on hold.`));
  if (!why.trim()) out.push(reason(400, "REASON_REQUIRED", "Give a reason for lifting the hold; it is kept in the audit trail."));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Bank details (a change is a new version; only a verified version is payable)
// ---------------------------------------------------------------------------------------------

export interface BankVersion {
  version: number;
  status: string;
  requestedBy: string | null;
}

export function checkBankDetails(d: { institution: string; transit: string; account: string }): Reason[] {
  const out: Reason[] = [];
  if (!/^\d{3}$/.test(d.institution)) out.push(reason(400, "INVALID_INSTITUTION", "The institution number must be 3 digits."));
  if (!/^\d{5}$/.test(d.transit)) out.push(reason(400, "INVALID_TRANSIT", "The transit (branch) number must be 5 digits."));
  if (!/^\d{7,12}$/.test(d.account)) out.push(reason(400, "INVALID_ACCOUNT_NUMBER", "The account number must be 7 to 12 digits."));
  return out;
}

export function checkBankRequest(versions: readonly BankVersion[], d: { institution: string; transit: string; account: string }): Reason[] {
  const out = checkBankDetails(d);
  if (versions.some((a) => a.status === "pending")) {
    out.push(reason(409, "CHANGE_ALREADY_PENDING", "A bank change is already waiting for verification; verify or reject it first."));
  }
  return out;
}

/** Verify: a second person (not whoever entered it). Reject: anyone allowed, including the requester withdrawing it. */
export function checkBankDecision(pending: BankVersion | undefined, actor: { id: string; fullName: string }, verb: "verify" | "reject", why = "x"): Reason[] {
  if (!pending) return [reason(409, "NO_PENDING_CHANGE", "There is no bank change waiting for verification.")];
  if (verb === "verify" && pending.requestedBy === actor.id) {
    return [reason(403, "ENTERED_IT", `${actor.fullName} entered these bank details, so a second person must verify them.`)];
  }
  if (verb === "reject" && !why.trim()) return [reason(400, "REASON_REQUIRED", "Give a reason for rejecting the bank change.")];
  return [];
}

const label = (s: VendorStatus) => s.replace(/_/g, " ");
