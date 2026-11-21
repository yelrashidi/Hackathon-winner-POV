/**
 * Feature 7 — the payment rules. Pure functions: everything they look at is passed in, so each
 * rule is one test and nothing here touches the store. "Can this person do X? If not, why?"
 * Every refusal is a { code, message } with the actual numbers and names in it.
 */

import { FAILURE_REASONS, type FailureCode, type FlagUrgency, type ReleaseCheck } from "@/contracts/payment";
import type { ApprovalPolicy } from "@/contracts/approvals";
import type { Flag } from "@/contracts/flag";
import type { DirectoryUser, UserRole } from "@/server/features/approvals";
import { cadMatches, formatMoney } from "./money";
import type { ApprovalFacts, BankAccountVersion, FlagRec, InvoiceRec, PaymentRec, VendorRec } from "./types";

export type Reason = ReleaseCheck["reasons"][number];

/** Roles the team's permission table lets prepare (schedule) payments, cancel, and clear flags. */
export const FINANCE_ROLES: ReadonlySet<UserRole> = new Set(["ap_clerk", "finance_manager", "controller_admin"]);
/** P09 / P10: who may release. */
export const RELEASE_ROLES: ReadonlySet<UserRole> = new Set(["finance_manager", "controller_admin"]);
/** Request a vendor bank change / verify one (roles-and-permissions.md). */
export const BANK_REQUEST_ROLES: ReadonlySet<UserRole> = new Set(["ap_clerk", "finance_manager", "controller_admin"]);
export const BANK_VERIFY_ROLES: ReadonlySet<UserRole> = new Set(["finance_manager", "controller_admin"]);

const ROLE_NAMES: Record<UserRole, string> = {
  employee: "Employee",
  ap_clerk: "AP Clerk",
  approver: "Approver",
  finance_manager: "Finance Manager",
  controller_admin: "Controller",
  auditor: "Auditor",
};

export function roleName(role: UserRole): string {
  return ROLE_NAMES[role] ?? role;
}

/** "ACCOUNT_CLOSED" → "Account closed". */
export function failureLabel(code: FailureCode): string {
  const words = code.toLowerCase().split("_").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const CRITICAL_RELEASE_MESSAGE = "Stopped: fraud hold on this supplier. Controller must review.";

/** The flag text for each urgency level (decided 2026-11-21, payment-decisions.md). */
export function flagMessage(urgency: FlagUrgency, code: FailureCode, date: string): string {
  if (urgency === "critical") return CRITICAL_RELEASE_MESSAGE;
  if (urgency === "high") return `Review: a payment to this supplier failed (${failureLabel(code)}) on ${date}.`;
  return `Last attempt failed: ${failureLabel(code)}. Retry when ready.`;
}

/** Q7: only people active today act. Returns why not, or null. */
export function inactiveReason(user: DirectoryUser, action: string): Reason | null {
  if (user.status === "active") return null;
  const since = user.statusSince ? ` since ${user.statusSince}` : "";
  const what =
    user.status === "on_leave" ? `on leave${since}` : user.status === "terminated" ? `no longer with the company${since}` : `not active (${user.status})`;
  return { code: "NOT_ACTIVE", message: `${user.fullName} is ${what}, so they can't ${action}.` };
}

// ---------------------------------------------------------------------------------------------
// Release
// ---------------------------------------------------------------------------------------------

/** The Finance Manager's release limit in CAD cents, from the P09-style policy; null if none. */
export function financeManagerReleaseLimit(policies: readonly ApprovalPolicy[]): { cadCents: number; policyId: string } | null {
  for (const p of policies) {
    if (p.ruleType !== "payment_release" || !p.active) continue;
    if (p.steps.type === "release_by" && p.steps.role === "finance_manager" && p.conditions.kind === "amount_up_to") {
      return { cadCents: p.conditions.cadCents, policyId: p.id };
    }
  }
  return null;
}

function controllerReleasePolicyId(policies: readonly ApprovalPolicy[]): string {
  const p = policies.find((x) => x.steps.type === "release_by" && x.steps.role === "controller_admin");
  return p?.id ?? "P10";
}

export interface ReleaseInput {
  actor: DirectoryUser | undefined;
  payment: PaymentRec;
  invoice: InvoiceRec;
  vendor: VendorRec | undefined;
  /** Every version of the vendor's bank account. */
  bankAccounts: readonly BankAccountVersion[];
  approval: ApprovalFacts | undefined;
  /** Open urgency flags on this payment's supplier or this payment. */
  paymentFlags: readonly FlagRec[];
  /** Open validation / duplicate flags on the invoice. */
  invoiceFlags: readonly Flag[];
  policies: readonly ApprovalPolicy[];
}

/** Can this person release this payment right now? Every reason that applies, not just the first. */
export function checkRelease(input: ReleaseInput): ReleaseCheck {
  const { actor, payment, invoice, vendor, bankAccounts, approval, paymentFlags, invoiceFlags, policies } = input;
  const reasons: Reason[] = [];

  // Who is acting
  if (!actor) {
    reasons.push({ code: "NOT_SIGNED_IN", message: "Pick a person in \"Viewing as\" to release payments." });
  } else {
    if (!RELEASE_ROLES.has(actor.role)) {
      reasons.push({
        code: "ROLE_CANNOT_RELEASE",
        message: `Only the Finance Manager or the Controller can release payments; ${actor.fullName} is ${roleName(actor.role)}.`,
      });
    }
    const inactive = inactiveReason(actor, "release payments");
    if (inactive) reasons.push(inactive);
  }

  // The payment itself
  if (payment.status !== "scheduled" && payment.status !== "on_hold") {
    reasons.push({ code: "NOT_SCHEDULED", message: `This payment is ${payment.status.replace("_", " ")}; only a scheduled payment can be released.` });
  }
  if (paymentFlags.some((f) => f.urgency === "critical" && f.scope === "supplier" && f.clearedAt === null)) {
    reasons.push({ code: "SUPPLIER_FRAUD_HOLD", message: CRITICAL_RELEASE_MESSAGE });
  } else if (payment.status === "on_hold") {
    reasons.push({ code: "ON_HOLD", message: `This payment is on hold: ${payment.holdReason ?? "no reason recorded"}.` });
  }
  if (payment.method !== "EFT") {
    reasons.push({ code: "METHOD_NOT_SUPPORTED", message: `Only EFT payments can be released here; this one is ${payment.method}.` });
  }
  if (invoice.isCreditNote || payment.amountCents <= 0) {
    reasons.push({ code: "CREDIT_NOTE", message: "A credit note is never paid out." });
  }

  // Amount and authority (limits in CAD at the invoice-date rate)
  if (!cadMatches(payment.amountCents, payment.fxRateToCad, payment.amountCadCents)) {
    reasons.push({
      code: "FX_MISMATCH",
      message: `${formatMoney(payment.amountCents, payment.currency)} × ${payment.fxRateToCad} does not equal the stored ${formatMoney(payment.amountCadCents)}; the CAD amount can't be trusted for the limit check.`,
    });
  }
  if (actor?.role === "finance_manager") {
    const limit = financeManagerReleaseLimit(policies);
    if (!limit) {
      reasons.push({ code: "NO_RELEASE_POLICY", message: "No release policy sets a Finance Manager limit, so only the Controller can release." });
    } else if (payment.amountCadCents > limit.cadCents) {
      reasons.push({
        code: "OVER_RELEASE_LIMIT",
        message: `${formatMoney(payment.amountCadCents)} is over the Finance Manager's release limit of ${formatMoney(limit.cadCents)} (policy ${limit.policyId}); the Controller must release it (policy ${controllerReleasePolicyId(policies)}).`,
      });
    }
  }

  // Separation of duties
  if (actor) {
    if (approval?.approverIds.includes(actor.id)) {
      reasons.push({ code: "APPROVED_IT", message: `${actor.fullName} approved this invoice, so they can't release its payment (policy P11).` });
    }
    if (payment.preparedBy === actor.id) {
      reasons.push({ code: "SCHEDULED_IT", message: `${actor.fullName} scheduled this payment, so someone else must release it.` });
    }
    if (invoice.requesterId === actor.id) {
      reasons.push({ code: "REQUESTED_IT", message: `${actor.fullName} requested this invoice, so they can't release its payment.` });
    }
  }

  // Pay only what was approved, to whom it was approved
  if (!approval) {
    reasons.push({ code: "NOT_APPROVED", message: "No approval record was found for this invoice." });
  } else if (!approval.basis) {
    reasons.push({ code: "NOT_APPROVED", message: `No approval plan is current for version ${invoice.version} of this invoice; it must be approved again.` });
  } else {
    if (payment.vendorId !== approval.basis.vendorId) {
      reasons.push({ code: "PAYEE_MISMATCH", message: `The payment goes to ${payment.vendorId}, but the approval was for ${approval.basis.vendorId}.` });
    }
    if (payment.currency !== approval.basis.currency || payment.amountCents > approval.basis.totalCents) {
      reasons.push({
        code: "AMOUNT_OVER_APPROVED",
        message: `The payment is ${formatMoney(payment.amountCents, payment.currency)}, but only ${formatMoney(approval.basis.totalCents, approval.basis.currency)} was approved.`,
      });
    }
  }

  // Supplier and bank account
  if (!vendor) {
    reasons.push({ code: "VENDOR_UNKNOWN", message: `Supplier ${payment.vendorId} is not in the vendor master.` });
  } else if (vendor.status !== "active") {
    reasons.push({ code: "VENDOR_NOT_ACTIVE", message: `${vendor.legalName} is ${vendor.status.replace("_", " ")}, so it can't be paid.` });
  }
  const account = bankAccounts.find((a) => a.version === payment.bankVersion);
  if (!account) {
    reasons.push({ code: "BANK_ACCOUNT_MISSING", message: "The bank account this payment was scheduled to no longer exists." });
  } else if (account.status === "closed") {
    reasons.push({
      code: "BANK_ACCOUNT_CLOSED",
      message: `Account ••${account.last4} can't be paid: a payment to it failed (${failureLabel(account.closedReason ?? "ACCOUNT_CLOSED")}). Enter and verify new bank details, then retry.`,
    });
  } else if (account.status !== "verified") {
    reasons.push({ code: "BANK_NOT_VERIFIED", message: `Account ••${account.last4} is ${account.status}, not verified; only a verified account can be paid.` });
  } else if (account.currency !== payment.currency) {
    reasons.push({ code: "BANK_CURRENCY_MISMATCH", message: `Account ••${account.last4} takes ${account.currency}, but this payment is in ${payment.currency}.` });
  }
  const pending = bankAccounts.find((a) => a.status === "pending");
  if (pending) {
    const how = pending.channel ? ` by ${pending.channel.replace(/_/g, " ")}` : "";
    const when = pending.changedAt ? ` on ${pending.changedAt}` : "";
    reasons.push({
      code: "BANK_CHANGE_PENDING",
      message: `${vendor?.legalName ?? "The supplier"}'s bank details were changed${when}${how} to ••${pending.last4} and not verified by a second person. Verify or reject the change first.`,
    });
  }

  // Anything validation or duplicates says must stop payment
  for (const f of invoiceFlags) {
    if (f.status === "open" && f.severity === "block") {
      reasons.push({ code: "BLOCKING_FLAG", message: `${f.code}: ${f.message}` });
    }
  }

  return { allowed: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------------------------
// Schedule (and retry: a retry is a new attempt that goes through every check)
// ---------------------------------------------------------------------------------------------

export interface ScheduleInput {
  actor: DirectoryUser | undefined;
  invoice: InvoiceRec;
  vendor: VendorRec | undefined;
  /** Every earlier attempt for this invoice, oldest first. */
  attempts: readonly PaymentRec[];
  bankAccounts: readonly BankAccountVersion[];
  /** Open urgency flags on this supplier. */
  supplierFlags: readonly FlagRec[];
  payDate: string;
  today: string;
}

export interface ScheduleCheck {
  allowed: boolean;
  reasons: Reason[];
  warnings: string[];
  /** Where the money would go: the single verified version. */
  account: BankAccountVersion | null;
  /** A critical flag is open on the supplier: the new attempt starts on hold. */
  startsOnHold: boolean;
}

export function checkSchedule(input: ScheduleInput): ScheduleCheck {
  const { actor, invoice, vendor, attempts, bankAccounts, supplierFlags, payDate, today } = input;
  const reasons: Reason[] = [];
  const warnings: string[] = [];

  if (!actor) {
    reasons.push({ code: "NOT_SIGNED_IN", message: "Pick a person in \"Viewing as\" to schedule payments." });
  } else {
    if (!FINANCE_ROLES.has(actor.role)) {
      reasons.push({ code: "ROLE_CANNOT_SCHEDULE", message: `Only an AP Clerk, the Finance Manager or the Controller can schedule payments; ${actor.fullName} is ${roleName(actor.role)}.` });
    }
    const inactive = inactiveReason(actor, "schedule payments");
    if (inactive) reasons.push(inactive);
  }
  if (invoice.status !== "Approved") {
    reasons.push({ code: "INVOICE_NOT_APPROVED", message: `Invoice ${invoice.vendorInvoiceNumber} is ${invoice.status}; only an approved invoice can be scheduled.` });
  }
  if (invoice.isCreditNote || invoice.totalCents <= 0) {
    reasons.push({ code: "CREDIT_NOTE", message: "A credit note is never paid out." });
  }
  const live = attempts.find((a) => a.status === "scheduled" || a.status === "on_hold" || a.status === "released");
  if (live) {
    reasons.push({ code: "ALREADY_ACTIVE", message: `Attempt ${live.attemptNo} is already ${live.status.replace("_", " ")}; only one attempt can be active at a time.` });
  }
  if (!vendor) {
    reasons.push({ code: "VENDOR_UNKNOWN", message: `Supplier ${invoice.vendorId} is not in the vendor master.` });
  } else if (vendor.status !== "active") {
    reasons.push({ code: "VENDOR_NOT_ACTIVE", message: `${vendor.legalName} is ${vendor.status.replace("_", " ")}, so it can't be paid.` });
  }

  const account = bankAccounts.find((a) => a.status === "verified") ?? null;
  const last = attempts[attempts.length - 1];
  const rule = last?.status === "failed" && last.failure ? FAILURE_REASONS[last.failure.code].retryRule : null;
  const needsNewBank = rule === "FIX_BANK_DETAILS" && (!account || account.version <= last!.bankVersion);
  if (!account && !needsNewBank) {
    reasons.push({ code: "NO_VERIFIED_BANK_ACCOUNT", message: `${vendor?.legalName ?? "The supplier"} has no verified bank account. Enter new details and have a second person verify them.` });
  }

  // Retry rules from the last failed attempt
  if (last?.status === "failed" && last.failure) {
    if (needsNewBank) {
      reasons.push({
        code: "FIX_BANK_DETAILS_FIRST",
        message: `Attempt ${last.attemptNo} failed (${failureLabel(last.failure.code)}). Enter new bank details and have a second person verify them before retrying.`,
      });
    }
    if (rule === "ESCALATE" && supplierFlags.some((f) => f.urgency === "critical" && f.clearedAt === null)) {
      reasons.push({ code: "CONTROLLER_MUST_CLEAR", message: `Attempt ${last.attemptNo} failed (${failureLabel(last.failure.code)}). The Controller must clear the fraud hold before a retry.` });
    }
  }

  if (payDate < today) {
    reasons.push({ code: "PAY_DATE_IN_PAST", message: `The pay date ${payDate} is in the past; pick ${today} or later.` });
  }
  if (isWeekend(payDate)) {
    warnings.push(`${payDate} is a ${weekdayName(payDate)}: banks don't run EFT on weekends, so the money would arrive late.`);
  }

  const startsOnHold = supplierFlags.some((f) => f.urgency === "critical" && f.scope === "supplier" && f.clearedAt === null);
  return { allowed: reasons.length === 0, reasons, warnings, account, startsOnHold };
}

// ---------------------------------------------------------------------------------------------
// Cancel, clear flags, bank changes
// ---------------------------------------------------------------------------------------------

export function checkCancel(actor: DirectoryUser | undefined, payment: PaymentRec, reason: string): Reason[] {
  const reasons: Reason[] = [];
  if (!actor) return [{ code: "NOT_SIGNED_IN", message: "Pick a person in \"Viewing as\" to cancel payments." }];
  if (!FINANCE_ROLES.has(actor.role)) {
    reasons.push({ code: "ROLE_CANNOT_CANCEL", message: `Only an AP Clerk, the Finance Manager or the Controller can cancel payments; ${actor.fullName} is ${roleName(actor.role)}.` });
  }
  const inactive = inactiveReason(actor, "cancel payments");
  if (inactive) reasons.push(inactive);
  if (payment.status !== "scheduled" && payment.status !== "on_hold") {
    reasons.push({ code: "CANNOT_CANCEL_NOW", message: `This payment is ${payment.status.replace("_", " ")}; it can only be cancelled before release.` });
  }
  if (!reason.trim()) reasons.push({ code: "REASON_REQUIRED", message: "Say why the payment is cancelled." });
  return reasons;
}

/** Who may clear an urgency flag (decided 2026-11-21). `scheduledBy` = who scheduled the payment that raised it. */
export function checkClearFlag(actor: DirectoryUser | undefined, flag: FlagRec, scheduledBy: string | null, note: string): Reason[] {
  if (!actor) return [{ code: "NOT_SIGNED_IN", message: "Pick a person in \"Viewing as\" to clear flags." }];
  const reasons: Reason[] = [];
  if (flag.clearedAt !== null) reasons.push({ code: "ALREADY_CLEARED", message: "This flag is already cleared." });
  if (!FINANCE_ROLES.has(actor.role)) {
    reasons.push({ code: "VIEW_ONLY", message: `${actor.fullName} is ${roleName(actor.role)} (view only) and can't clear flags.` });
  }
  const inactive = inactiveReason(actor, "clear flags");
  if (inactive) reasons.push(inactive);
  if (flag.urgency === "critical") {
    if (actor.role !== "controller_admin") {
      reasons.push({ code: "CONTROLLER_ONLY", message: "Only the Controller can clear a fraud hold." });
    }
    if (scheduledBy === actor.id) {
      reasons.push({ code: "SCHEDULED_IT", message: `${actor.fullName} scheduled the payment that raised this flag, so someone else must clear it.` });
    }
  }
  if ((flag.urgency === "critical" || flag.urgency === "high") && !note.trim()) {
    reasons.push({ code: "NOTE_REQUIRED", message: `A note is required to clear a ${flag.urgency} flag.` });
  }
  return reasons;
}

export function checkBankRequest(actor: DirectoryUser | undefined, existing: readonly BankAccountVersion[], details: { institution: string; transit: string; account: string }): Reason[] {
  if (!actor) return [{ code: "NOT_SIGNED_IN", message: "Pick a person in \"Viewing as\" to change bank details." }];
  const reasons: Reason[] = [];
  if (!BANK_REQUEST_ROLES.has(actor.role)) {
    reasons.push({ code: "ROLE_CANNOT_REQUEST", message: `Only an AP Clerk, the Finance Manager or the Controller can enter new bank details; ${actor.fullName} is ${roleName(actor.role)}.` });
  }
  const inactive = inactiveReason(actor, "change bank details");
  if (inactive) reasons.push(inactive);
  if (existing.some((a) => a.status === "pending")) {
    reasons.push({ code: "CHANGE_ALREADY_PENDING", message: "A bank change is already waiting for verification; verify or reject it first." });
  }
  if (!/^\d{3}$/.test(details.institution)) reasons.push({ code: "INVALID_INSTITUTION", message: "The institution number must be 3 digits." });
  if (!/^\d{5}$/.test(details.transit)) reasons.push({ code: "INVALID_TRANSIT", message: "The transit (branch) number must be 5 digits." });
  if (!/^\d{7,12}$/.test(details.account)) reasons.push({ code: "INVALID_ACCOUNT_NUMBER", message: "The account number must be 7 to 12 digits." });
  return reasons;
}

/** Verify or reject a pending bank change: Finance Manager or Controller, never whoever entered it. */
export function checkBankDecision(actor: DirectoryUser | undefined, pending: BankAccountVersion | undefined, verb: "verify" | "reject"): Reason[] {
  if (!actor) return [{ code: "NOT_SIGNED_IN", message: `Pick a person in "Viewing as" to ${verb} bank details.` }];
  const reasons: Reason[] = [];
  if (!pending) return [{ code: "NO_PENDING_CHANGE", message: "There is no bank change waiting for verification." }];
  if (!BANK_VERIFY_ROLES.has(actor.role)) {
    reasons.push({ code: "ROLE_CANNOT_VERIFY", message: `Only the Finance Manager or the Controller can ${verb} bank details; ${actor.fullName} is ${roleName(actor.role)}.` });
  }
  const inactive = inactiveReason(actor, `${verb} bank details`);
  if (inactive) reasons.push(inactive);
  if (verb === "verify" && pending.requestedBy === actor.id) {
    reasons.push({ code: "ENTERED_IT", message: `${actor.fullName} entered these bank details, so a second person must verify them.` });
  }
  return reasons;
}

// ---------------------------------------------------------------------------------------------
// Pay date (Q2, Q3)
// ---------------------------------------------------------------------------------------------

function utcDate(isoDate: string, plusDays = 0): Date {
  const y = Number(isoDate.slice(0, 4));
  const m = Number(isoDate.slice(5, 7));
  const d = Number(isoDate.slice(8, 10));
  return new Date(Date.UTC(y, m - 1, d + plusDays));
}

function dayOfWeek(isoDate: string): number {
  return utcDate(isoDate).getUTCDay();
}

function addDays(isoDate: string, days: number): string {
  return utcDate(isoDate, days).toISOString().slice(0, 10);
}

export function isWeekend(isoDate: string): boolean {
  const day = dayOfWeek(isoDate);
  return day === 0 || day === 6;
}

function weekdayName(isoDate: string): string {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][dayOfWeek(isoDate)] ?? isoDate;
}

/**
 * The due date, or today if it has passed. A Saturday or Sunday moves back to the Friday before;
 * if that Friday is already past, forward to the next Monday instead.
 */
export function defaultPayDate(dueDate: string, today: string): string {
  let date = dueDate < today ? today : dueDate;
  if (isWeekend(date)) {
    const friday = addDays(date, dayOfWeek(date) === 6 ? -1 : -2);
    date = friday >= today ? friday : addDays(date, dayOfWeek(date) === 6 ? 2 : 1);
  }
  return date;
}
