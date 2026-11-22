import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { z } from "zod";
import type { Actor } from "@/contracts/actor";
import {
  BankDetailsInput,
  OnboardVendorInput,
  type BankActionResult,
  type BankDetailsInput as BankDetailsInputType,
  type OnboardVendorInput as OnboardVendorInputType,
  type VendorActionResult,
  type VendorDraft,
  type VendorReason,
  type VendorStatus,
} from "@/contracts/vendor";
import type { ActionContext } from "@/server/core/audit";
import { recordDenied } from "@/server/core/audit";
import { authorize, Forbidden } from "@/server/core/authorize";
import { getDb, type Db } from "@/server/db/client";
import { glAccounts, invoices, vendorBankAccounts, vendors } from "@/server/db/schema";
import { matchVendor } from "@/server/features/validation/vendor-match";
import type { VendorRef } from "@/server/features/validation/context";
import { reanalyseWithin } from "@/server/pipeline/ingest";
import { invoiceInputFromDb } from "@/server/pipeline/input";
import { checkApprove, checkBankDecision, checkBankDetails, checkBankRequest, checkHold, checkReleaseHold, findExistingVendor, type Reason } from "./rules";
import { bankEntityId, bankVersions, loadVendorState, notFound, refuseIf, todayIso, vendorAction, VendorError } from "./shared";

/**
 * Feature 9 — the vendor master's write actions. Each one is a single transaction:
 *
 *   authorize (role) → lock the vendor row → rules (state, two people) → write → audit
 *   → re-check that vendor's open invoices, so their flags follow the change
 *
 *   onboardVendor        new vendor → pending_review (+ optional first bank account, pending)
 *   approveVendor        pending_review → active            second person, not the onboarder
 *   holdVendor           active | pending_review → on_hold   reason required
 *   releaseVendorHold    on_hold → the status before the hold (manager only), reason required
 *   requestBankChange    new bank account version, pending
 *   verifyBankChange     pending → verified; the old verified version → superseded (second person)
 *   rejectBankChange     pending → rejected, reason required
 *   vendorDraftFromInvoice   read-only: the onboarding form prefilled from an unknown-vendor invoice
 *
 * Why re-check invoices: validation flags VENDOR_NOT_ACTIVE / BANK_* from the vendor master. After a
 * vendor is approved or its bank details verified, those flags must clear on their own (and appear
 * on a hold) — not wait for someone to edit the invoice. The re-check's audit rows share this
 * action's request id, so the audit trail shows the cause.
 */

export interface VendorOptions {
  db?: Db;
  /** "Today" for the date rules on re-checked invoices and the onboarding date. */
  today?: string;
}

/** Invoices still being worked on; their flags must follow the vendor master. */
const OPEN_FOR_CHECKS = ["InReview", "OnHold"] as const;

const publicReasons = (rs: readonly Reason[]): VendorReason[] => rs.map(({ code, message }) => ({ code, message }));

// ---------------------------------------------------------------------------------------------
// Onboarding and status
// ---------------------------------------------------------------------------------------------

export async function onboardVendor(actor: Actor, body: OnboardVendorInputType, opts: VendorOptions = {}): Promise<VendorActionResult> {
  const db = opts.db ?? getDb();
  const today = opts.today ?? todayIso();
  return vendorAction(actor, "vendor.onboard", "new", db, async (action, me) => {
    const { tx } = action;
    const input = parseOrRefuse(OnboardVendorInput, body);
    if (input.bankAccount) refuseIf(checkBankDetails(input.bankAccount));
    if (input.defaultGlAccount) {
      const [gl] = await tx.select({ n: glAccounts.accountNumber }).from(glAccounts).where(eq(glAccounts.accountNumber, input.defaultGlAccount));
      if (!gl) throw new VendorError([{ code: "UNKNOWN_GL_ACCOUNT", message: `GL account ${input.defaultGlAccount} does not exist.` }], 400);
    }
    if (input.fromInvoiceId) {
      const [inv] = await tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.id, input.fromInvoiceId));
      if (!inv) throw new VendorError([{ code: "INVOICE_NOT_FOUND", message: `Invoice ${input.fromInvoiceId} does not exist.` }], 400);
    }

    // One onboarding at a time picks the next id and checks for duplicates (no race on "V057").
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('vendors.onboard'))`);
    const existing = await tx.select({ id: vendors.id, legalName: vendors.legalName, gstHstNumber: vendors.gstHstNumber, qstNumber: vendors.qstNumber, apContactEmail: vendors.apContactEmail }).from(vendors);
    const { refusals, warnings } = findExistingVendor(input, existing);
    refuseIf(refusals);

    const vendorId = nextVendorId(existing.map((v) => v.id));
    const row = {
      id: vendorId,
      legalName: input.legalName,
      category: input.category,
      defaultGlAccount: input.defaultGlAccount,
      address: input.address,
      provinceOrState: input.provinceOrState,
      country: input.country,
      gstHstNumber: input.gstHstNumber,
      qstNumber: input.qstNumber,
      paymentTermsDays: input.paymentTermsDays,
      preferredPaymentMethod: input.preferredPaymentMethod,
      acceptsCardPayment: input.acceptsCardPayment,
      apContactEmail: input.apContactEmail,
      requiresPo: input.requiresPo,
      status: "pending_review" as const,
      onboardedAt: today,
    };
    await tx.insert(vendors).values(row);
    await action.audit({
      action: "vendor.created",
      entityType: "vendor",
      entityId: vendorId,
      after: row,
      metadata: { fromInvoiceId: input.fromInvoiceId, warnings: warnings.map((w) => w.code) },
    });

    if (input.bankAccount) await addPendingBankVersion(action, vendorId, 1, input.bankAccount, me.id, today);

    // Re-check the invoice that revealed this vendor, and any other open unknown-vendor invoice
    // that validation's matcher now ties to it (same tax number, name or email domain).
    const ref: VendorRef = { ...row, province: row.provinceOrState, contactEmail: row.apContactEmail, invoiceCount: 0 };
    const unmatched = await tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(isNull(invoices.vendorId), inArray(invoices.status, [...OPEN_FOR_CHECKS]), ne(invoices.source, "historical")))
      .orderBy(asc(invoices.id));
    const toCheck = new Set<string>();
    for (const { id } of unmatched) {
      const inv = await invoiceInputFromDb(tx, id, today);
      if (id === input.fromInvoiceId || matchVendor({ vendor: inv.vendor, senderEmail: inv.senderEmail }, [ref]).vendor) toCheck.add(id);
    }
    const revalidatedInvoices = await reanalyse(action, [...toCheck], today);
    return { vendorId, status: "pending_review", warnings: publicReasons(warnings), revalidatedInvoices };
  });
}

export async function approveVendor(actor: Actor, vendorId: string, body: { note?: string | null } = {}, opts: VendorOptions = {}): Promise<VendorActionResult> {
  const db = opts.db ?? getDb();
  return vendorAction(actor, "vendor.approve", vendorId, db, async (action, me) => {
    const v = await loadVendorState(action.tx, vendorId, true);
    if (!v) throw notFound(vendorId);
    refuseIf(checkApprove(v, me));
    return changeStatus(action, v, "active", body.note?.trim() || null, opts.today ?? todayIso());
  });
}

export async function holdVendor(actor: Actor, vendorId: string, body: { reason: string }, opts: VendorOptions = {}): Promise<VendorActionResult> {
  const db = opts.db ?? getDb();
  return vendorAction(actor, "vendor.hold", vendorId, db, async (action) => {
    const v = await loadVendorState(action.tx, vendorId, true);
    if (!v) throw notFound(vendorId);
    const why = String(body?.reason ?? "");
    refuseIf(checkHold(v, why));
    return changeStatus(action, v, "on_hold", why.trim(), opts.today ?? todayIso());
  });
}

export async function releaseVendorHold(actor: Actor, vendorId: string, body: { reason: string }, opts: VendorOptions = {}): Promise<VendorActionResult> {
  const db = opts.db ?? getDb();
  return vendorAction(actor, "vendor.release_hold", vendorId, db, async (action) => {
    const v = await loadVendorState(action.tx, vendorId, true);
    if (!v) throw notFound(vendorId);
    const why = String(body?.reason ?? "");
    refuseIf(checkReleaseHold(v, why));
    // Back to where it was: lifting a hold must not approve a vendor nobody approved.
    const before = v.history.statusBeforeHold;
    const to: VendorStatus = before === "pending_review" ? "pending_review" : "active";
    return changeStatus(action, v, to, why.trim(), opts.today ?? todayIso());
  });
}

async function changeStatus(action: ActionContext, v: { id: string; status: VendorStatus }, to: VendorStatus, reason: string | null, today: string): Promise<VendorActionResult> {
  await action.tx.update(vendors).set({ status: to }).where(eq(vendors.id, v.id));
  await action.audit({ action: "vendor.status_changed", entityType: "vendor", entityId: v.id, before: { status: v.status }, after: { status: to }, reason });
  const revalidatedInvoices = await reanalyseVendorInvoices(action, v.id, today);
  return { vendorId: v.id, status: to, warnings: [], revalidatedInvoices };
}

// ---------------------------------------------------------------------------------------------
// Bank details
// ---------------------------------------------------------------------------------------------

export async function requestBankChange(actor: Actor, vendorId: string, body: BankDetailsInputType, opts: VendorOptions = {}): Promise<BankActionResult> {
  const db = opts.db ?? getDb();
  const today = opts.today ?? todayIso();
  return vendorAction(actor, "vendor.bank_change.request", vendorId, db, async (action, me) => {
    const v = await loadVendorState(action.tx, vendorId, true);
    if (!v) throw notFound(vendorId);
    const details = parseOrRefuse(BankDetailsInput, body);
    const versions = await bankVersions(action.tx, vendorId);
    refuseIf(checkBankRequest(versions, details));
    const version = (versions[0]?.version ?? 0) + 1;
    await addPendingBankVersion(action, vendorId, version, details, me.id, today);
    const revalidatedInvoices = await reanalyseVendorInvoices(action, vendorId, today);
    return { vendorId, version, status: "pending", last4: details.account.slice(-4), revalidatedInvoices };
  });
}

export async function verifyBankChange(actor: Actor, vendorId: string, opts: VendorOptions = {}): Promise<BankActionResult> {
  const db = opts.db ?? getDb();
  return vendorAction(actor, "vendor.bank_change.verify", vendorId, db, async (action, me) => {
    const { tx } = action;
    const v = await loadVendorState(tx, vendorId, true);
    if (!v) throw notFound(vendorId);
    const versions = await bankVersions(tx, vendorId);
    const pending = versions.find((a) => a.status === "pending");
    refuseIf(checkBankDecision(pending, me, "verify"));
    // Only one payable account: retire the old one first (a unique index allows one `verified`).
    const old = versions.find((a) => a.status === "verified");
    if (old) await tx.update(vendorBankAccounts).set({ status: "superseded" }).where(eq(vendorBankAccounts.id, old.id));
    await tx.update(vendorBankAccounts).set({ status: "verified", verifiedBy: me.id, verifiedAt: sql`now()` }).where(eq(vendorBankAccounts.id, pending!.id));
    await action.audit({
      action: "bank_account.verified",
      entityType: "bank_account",
      entityId: bankEntityId(vendorId, pending!.version),
      before: { status: "pending" },
      after: { status: "verified", version: pending!.version, last4: pending!.last4 },
      metadata: { vendorId, supersededVersion: old?.version ?? null },
    });
    const revalidatedInvoices = await reanalyseVendorInvoices(action, vendorId, opts.today ?? todayIso());
    return { vendorId, version: pending!.version, status: "verified", last4: pending!.last4, revalidatedInvoices };
  });
}

export async function rejectBankChange(actor: Actor, vendorId: string, body: { reason: string }, opts: VendorOptions = {}): Promise<BankActionResult> {
  const db = opts.db ?? getDb();
  return vendorAction(actor, "vendor.bank_change.verify", vendorId, db, async (action, me) => {
    const { tx } = action;
    const v = await loadVendorState(tx, vendorId, true);
    if (!v) throw notFound(vendorId);
    const pending = (await bankVersions(tx, vendorId)).find((a) => a.status === "pending");
    const why = String(body?.reason ?? "");
    refuseIf(checkBankDecision(pending, me, "reject", why));
    await tx.update(vendorBankAccounts).set({ status: "rejected" }).where(eq(vendorBankAccounts.id, pending!.id));
    await action.audit({
      action: "bank_account.rejected",
      entityType: "bank_account",
      entityId: bankEntityId(vendorId, pending!.version),
      before: { status: "pending" },
      after: { status: "rejected", version: pending!.version, last4: pending!.last4 },
      reason: why.trim(),
      metadata: { vendorId },
    });
    const revalidatedInvoices = await reanalyseVendorInvoices(action, vendorId, opts.today ?? todayIso());
    return { vendorId, version: pending!.version, status: "rejected", last4: pending!.last4, revalidatedInvoices };
  });
}

/** A new bank account version, `pending` until a second person verifies it. Full number stays in the DB. */
async function addPendingBankVersion(action: ActionContext, vendorId: string, version: number, raw: BankDetailsInputType, requestedBy: string, today: string) {
  const d = BankDetailsInput.parse(raw);
  const last4 = d.account.slice(-4);
  await action.tx.insert(vendorBankAccounts).values({
    vendorId,
    version,
    status: "pending",
    currency: d.currency,
    institution: d.institution,
    transit: d.transit,
    account: d.account,
    last4,
    changedAt: today,
    channel: d.channel,
    requestedBy,
  });
  await action.audit({
    action: "bank_account.change_requested",
    entityType: "bank_account",
    entityId: bankEntityId(vendorId, version),
    after: { version, status: "pending", last4, currency: d.currency, channel: d.channel },
    metadata: { vendorId },
  });
}

// ---------------------------------------------------------------------------------------------
// Onboarding form prefilled from an invoice (read-only)
// ---------------------------------------------------------------------------------------------

export async function vendorDraftFromInvoice(actor: Actor, invoiceId: string, opts: { db?: Db } = {}): Promise<VendorDraft> {
  const db = opts.db ?? getDb();
  try {
    authorize(actor, "vendor.onboard");
  } catch (err) {
    if (err instanceof Forbidden) await recordDenied(actor, { attempted: "vendor.onboard", reason: err.reason, entityType: "invoice", entityId: invoiceId, invoiceId }, { db });
    throw err;
  }
  const [inv] = await db.select({ extractionRaw: invoices.extractionRaw }).from(invoices).where(eq(invoices.id, invoiceId));
  if (!inv) throw new VendorError([{ code: "INVOICE_NOT_FOUND", message: `Invoice ${invoiceId} does not exist.` }], 404);
  const input = await invoiceInputFromDb(db, invoiceId);
  // Intake keeps extraction's full reading, which also has the printed address.
  const reading = (inv.extractionRaw as { reading?: { extracted?: { vendor?: { address?: string | null } } } } | null)?.reading;
  const draft = {
    legalName: input.vendor.nameRaw,
    gstHstNumber: input.vendor.gstHstNumber,
    qstNumber: input.vendor.qstNumber,
    apContactEmail: input.senderEmail,
  };
  const existing = await db.select({ id: vendors.id, legalName: vendors.legalName, gstHstNumber: vendors.gstHstNumber, qstNumber: vendors.qstNumber, apContactEmail: vendors.apContactEmail }).from(vendors);
  const { refusals, warnings } = findExistingVendor({ ...draft, legalName: draft.legalName ?? "" }, existing);
  const names = new Map(existing.map((e) => [e.id, e.legalName]));
  return {
    fromInvoiceId: invoiceId,
    ...draft,
    address: reading?.extracted?.vendor?.address ?? null,
    provinceOrState: input.vendor.province,
    country: input.vendor.country,
    similarVendors: [...refusals, ...warnings].filter((r) => r.vendorId).map((r) => ({ vendorId: r.vendorId!, legalName: names.get(r.vendorId!) ?? r.vendorId!, why: r.message })),
  };
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** Re-runs validation + coding on the vendor's open invoices (see the note at the top). */
async function reanalyseVendorInvoices(action: ActionContext, vendorId: string, today: string): Promise<string[]> {
  const rows = await action.tx
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.vendorId, vendorId), inArray(invoices.status, [...OPEN_FOR_CHECKS]), ne(invoices.source, "historical")))
    .orderBy(asc(invoices.id));
  return reanalyse(action, rows.map((r) => r.id), today);
}

async function reanalyse(action: ActionContext, ids: readonly string[], today: string): Promise<string[]> {
  for (const id of ids) await reanalyseWithin(action, id, today);
  return [...ids];
}

/** "V056" → "V057". Ids that do not look like V + digits are ignored. */
export function nextVendorId(ids: readonly string[]): string {
  const max = ids.reduce((m, id) => (/^V\d+$/.test(id) ? Math.max(m, Number(id.slice(1))) : m), 0);
  return `V${String(max + 1).padStart(3, "0")}`;
}

/** Shapes the input with its contract schema; anything malformed is a 400 listing every problem. */
function parseOrRefuse<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const r = schema.safeParse(body);
  if (r.success) return r.data;
  throw new VendorError(
    r.error.issues.map((i) => ({ code: "INVALID_INPUT", message: i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message })),
    400,
  );
}
