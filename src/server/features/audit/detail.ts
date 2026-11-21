import { asc, eq, inArray } from "drizzle-orm";
import type { Actor } from "@/contracts/actor";
import type { AuditInvoiceDetail } from "@/contracts/audit-view";
import { getDb, type Db } from "@/server/db/client";
import { approvalPlans, approvalSteps, documents, glAccounts, invoiceFlags, invoiceLines, invoiceTaxes, invoices, paymentFlags, payments, vendorBankAccounts, vendors } from "@/server/db/schema";
import { controlChecks } from "./controls";
import { AuditNotFound, guard, iso, loadPeople } from "./shared";
import { invoiceTimeline } from "./timeline";

/**
 * Screen 2 of the auditor dashboard: everything about one invoice, in the order an auditor reads
 * it — header and source document, what extraction read, lines with GL codes, tax, every validation
 * run, every flag and who closed it, the approval chain (incl. delegates), payments with the exact
 * bank-account version paid to, automatic control tests, and the full timeline. Auditor only.
 *
 *   getInvoiceAuditDetail(actor, invoiceId)
 *   getPaymentAuditDetail(actor, paymentId)   same page, entered from a payment (demo #6)
 */
export async function getInvoiceAuditDetail(actor: Actor, invoiceId: string, opts: { db?: Db } = {}): Promise<AuditInvoiceDetail> {
  const db = opts.db ?? getDb();
  await guard(actor, "audit.view", db, { invoiceId });
  return buildDetail(db, invoiceId);
}

export async function getPaymentAuditDetail(actor: Actor, paymentId: string, opts: { db?: Db } = {}): Promise<AuditInvoiceDetail> {
  const db = opts.db ?? getDb();
  await guard(actor, "audit.view", db);
  const [p] = await db.select({ invoiceId: payments.invoiceId }).from(payments).where(eq(payments.id, paymentId));
  if (!p) throw new AuditNotFound(`Payment ${paymentId} does not exist.`);
  return buildDetail(db, p.invoiceId);
}

async function buildDetail(db: Db, invoiceId: string): Promise<AuditInvoiceDetail> {
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!inv) throw new AuditNotFound(`Invoice ${invoiceId} does not exist.`);

  const [people, vendor, doc, lines, taxes, flags, plans, steps, pays] = await Promise.all([
    loadPeople(db),
    inv.vendorId ? db.select().from(vendors).where(eq(vendors.id, inv.vendorId)).then((r) => r[0] ?? null) : Promise.resolve(null),
    inv.documentId ? db.select().from(documents).where(eq(documents.id, inv.documentId)).then((r) => r[0] ?? null) : Promise.resolve(null),
    db
      .select({ line: invoiceLines, glName: glAccounts.name })
      .from(invoiceLines)
      .leftJoin(glAccounts, eq(glAccounts.accountNumber, invoiceLines.glAccountCode))
      .where(eq(invoiceLines.invoiceId, invoiceId))
      .orderBy(asc(invoiceLines.lineNo)),
    db.select().from(invoiceTaxes).where(eq(invoiceTaxes.invoiceId, invoiceId)).orderBy(asc(invoiceTaxes.id)),
    db.select().from(invoiceFlags).where(eq(invoiceFlags.invoiceId, invoiceId)).orderBy(asc(invoiceFlags.id)),
    db.select().from(approvalPlans).where(eq(approvalPlans.invoiceId, invoiceId)).orderBy(asc(approvalPlans.attempt)),
    db.select().from(approvalSteps).where(eq(approvalSteps.invoiceId, invoiceId)).orderBy(asc(approvalSteps.planId), asc(approvalSteps.seq)),
    db.select().from(payments).where(eq(payments.invoiceId, invoiceId)).orderBy(asc(payments.attemptNo), asc(payments.id)),
  ]);

  const bankIds = pays.map((p) => p.bankAccountId).filter((x): x is number => x !== null);
  const banks = bankIds.length ? await db.select().from(vendorBankAccounts).where(inArray(vendorBankAccounts.id, bankIds)) : [];
  const bankById = new Map(banks.map((b) => [b.id, b]));
  const payFlags = pays.length
    ? await db
        .select()
        .from(paymentFlags)
        .where(inArray(paymentFlags.paymentId, pays.map((p) => p.id)))
        .orderBy(asc(paymentFlags.createdAt))
    : [];
  const { events, rows: eventRows } = await invoiceTimeline(
    db,
    invoiceId,
    pays.map((p) => p.id),
    people,
  );

  const validationRuns = eventRows
    .filter((e) => e.action === "invoice.validated")
    .sort((a, b) => b.id - a.id)
    .map((e) => {
      const a = (e.after ?? {}) as Record<string, unknown>;
      return {
        occurredAt: iso(e.occurredAt)!,
        invoiceVersion: typeof a.invoiceVersion === "number" ? a.invoiceVersion : null,
        vendorId: (a.vendorId as string | null) ?? null,
        vendorMatch: a.vendorMatch ?? null,
        contractId: (a.contractId as string | null) ?? null,
        fxRate: (a.fxRate as string | null) ?? null,
        totalCadCents: typeof a.totalCadCents === "number" ? a.totalCadCents : null,
        blocking: a.blocking === true,
        flags: Array.isArray(a.flags) ? (a.flags as { code: string; severity: string }[]) : [],
      };
    });

  const base: Omit<AuditInvoiceDetail, "controls" | "timeline"> = {
    invoice: {
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      status: inv.status,
      legacyStatus: inv.legacyStatus,
      version: inv.version,
      source: inv.source,
      invoiceDate: inv.invoiceDate,
      receivedDate: inv.receivedDate,
      dueDate: inv.dueDate,
      currency: inv.currency,
      subtotalCents: inv.subtotalCents,
      totalCents: inv.totalCents,
      totalCadCents: inv.totalCadCents,
      fxRate: inv.fxRate,
      shipToProvince: inv.shipToProvince,
      isCreditNote: inv.isCreditNote,
      poId: inv.poId,
      contractId: inv.contractId,
      departmentId: inv.departmentId,
      requester: people(inv.requesterId),
      vendor: vendor ? { vendorId: vendor.id, legalName: vendor.legalName, status: vendor.status, category: vendor.category } : null,
      vendorNameRaw: inv.vendorNameRaw,
      createdAt: iso(inv.createdAt)!,
    },
    document: doc ? { documentId: doc.id, storageKey: doc.storageKey, fileName: doc.fileName, sha256: doc.sha256 } : null,
    extraction: { raw: inv.extractionRaw ?? null, confidence: inv.extractionConfidence ?? null },
    lines: lines.map(({ line: l, glName }) => ({
      lineNo: l.lineNo,
      description: l.description,
      lineType: l.lineType,
      qty: l.qty,
      unitPriceCents: l.unitPriceCents,
      amountCents: l.amountCents,
      glAccount: l.glAccountCode ? { code: l.glAccountCode, name: glName } : null,
      departmentId: l.departmentId,
      taxCodes: [l.gstHstCode, l.pstQstCode].filter((x): x is string => !!x),
      codingSource: l.codingSource,
    })),
    taxes: taxes.map((t) => ({ code: t.taxCode, label: t.label, rate: t.rate, amountCents: t.amountCents })),
    validationRuns,
    flags: flags.map((f) => ({
      flagId: f.id,
      source: f.source,
      code: f.code,
      severity: f.severity,
      message: f.message,
      evidence: (f.evidence ?? {}) as Record<string, unknown>,
      status: f.status,
      raisedAt: iso(f.raisedAt)!,
      resolvedBy: people(f.resolvedBy),
      resolvedAt: iso(f.resolvedAt),
      resolutionNote: f.resolutionNote,
      relatedInvoiceId: f.relatedInvoiceId,
    })),
    approvals: plans.map((p) => ({
      planId: p.id,
      attempt: p.attempt,
      invoiceVersion: p.invoiceVersion,
      outcome: p.outcome,
      routedAt: iso(p.routedAt)!,
      steps: steps
        .filter((s) => s.planId === p.id)
        .map((s) => ({
          seq: s.seq,
          role: s.role,
          policyId: s.policyId,
          policyVersion: s.policyVersion,
          reasons: s.reasons,
          assignedTo: people(s.assignedTo),
          actedBy: people(s.actedBy),
          onBehalfOf: people(s.onBehalfOf),
          actedAs: s.actedAs ?? null,
          decision: s.decision,
          comment: s.comment,
          decidedAt: iso(s.decidedAt),
          acknowledgedFlags: s.acknowledgedFlags,
        })),
    })),
    payments: pays.map((p) => {
      const b = p.bankAccountId !== null ? bankById.get(p.bankAccountId) : undefined;
      return {
        paymentId: p.id,
        attemptNo: p.attemptNo,
        method: p.method,
        status: p.status,
        currency: p.currency,
        amountCents: p.amountCents,
        amountCadCents: p.amountCadCents,
        scheduledDate: p.scheduledDate,
        paidDate: p.paidDate,
        reference: p.reference,
        preparedBy: people(p.preparedBy),
        releasedBy: people(p.releasedBy),
        releasedAt: iso(p.releasedAt),
        settledAt: iso(p.settledAt),
        failedAt: iso(p.failedAt),
        failureCode: p.failureCode,
        failure: p.failure ?? null,
        cancelledAt: iso(p.cancelledAt),
        cancelledBy: people(p.cancelledBy),
        cancelReason: p.cancelReason,
        holdReason: p.holdReason,
        bankAccount: b
          ? {
              version: b.version,
              status: b.status,
              currency: b.currency,
              institution: b.institution,
              last4: b.last4,
              changedAt: b.changedAt,
              channel: b.channel,
              requestedBy: people(b.requestedBy),
              verifiedBy: people(b.verifiedBy),
              verifiedAt: iso(b.verifiedAt),
            }
          : null,
      };
    }),
    paymentFlags: payFlags.map((f) => ({
      flagId: f.id,
      paymentId: f.paymentId,
      urgency: f.urgency,
      reasonCode: f.reasonCode,
      message: f.message,
      scope: f.scope,
      createdAt: iso(f.createdAt)!,
      clearedBy: people(f.clearedBy),
      clearedAt: iso(f.clearedAt),
      clearNote: f.clearNote,
      clearedAutomatically: f.clearedAutomatically,
    })),
  };
  return { ...base, controls: controlChecks(base), timeline: events };
}

