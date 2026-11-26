import { z } from "zod";

/**
 * Feature 8 — what the AUDITOR dashboard renders. Built by src/server/features/audit; the
 * dashboard owner builds the two screens against these shapes (fixtures in fixtures/audit/).
 *
 *   Screen 1  /audit                 table of every invoice → AuditInvoiceList
 *   Screen 2  /audit/invoices/[id]   everything about one invoice → AuditInvoiceDetail
 *
 * Money is integer cents (format at render time); timestamps are ISO strings; dates YYYY-MM-DD.
 */

const Cents = z.number().int();

export const Person = z.object({
  userId: z.string(),
  name: z.string(),
  /** Role today. For the role someone held WHEN they acted, see the timeline / actedAs. */
  role: z.string(),
});
export type Person = z.infer<typeof Person>;

// ---------------------------------------------------------------------------------------------
// Screen 1 — the invoice table
// ---------------------------------------------------------------------------------------------

export const AuditInvoiceRow = z.object({
  invoiceId: z.string(),
  invoiceNumber: z.string().nullable(),
  vendorId: z.string().nullable(),
  vendorName: z.string().nullable(),
  invoiceDate: z.string().nullable(),
  receivedDate: z.string().nullable(),
  currency: z.string().nullable(),
  totalCents: Cents.nullable(),
  totalCadCents: Cents.nullable(),
  /** State-machine status (Paid, PendingApproval, Voided…). */
  status: z.string(),
  /** historical | email | upload | manual */
  source: z.string(),
  flags: z.object({
    open: z.number().int(),
    openBlocking: z.number().int(),
    resolved: z.number().int(),
    overridden: z.number().int(),
  }),
  /** Who signed the last approved step, and when. */
  finalApprover: z.object({ person: Person, at: z.string().nullable() }).nullable(),
  payment: z
    .object({
      status: z.string(),
      paidDate: z.string().nullable(),
      releasedBy: Person.nullable(),
      amountCents: Cents,
    })
    .nullable(),
  lastActivityAt: z.string().nullable(),
  eventCount: z.number().int(),
});
export type AuditInvoiceRow = z.infer<typeof AuditInvoiceRow>;

/**
 * How a list of invoices is ordered. Newest first (by invoice date) is the default; the vendor sorts
 * are alphabetical by the vendor's legal name (or the name on the bill when the vendor is unknown).
 * Every sort ends on the invoice id, so paging never repeats or skips a row.
 */
export const InvoiceSort = z.enum(["newest", "oldest", "vendor_az", "vendor_za"]);
export type InvoiceSort = z.infer<typeof InvoiceSort>;

export const AuditInvoiceListQuery = z.object({
  /** Matches invoice id, invoice number or vendor name (case-insensitive). */
  search: z.string().trim().optional(),
  status: z.string().optional(),
  /** Only these statuses (e.g. the Auditor's "past invoices": decided ones). Combined with `status`. */
  statuses: z.array(z.string()).optional(),
  vendorId: z.string().optional(),
  /** Invoice date range, inclusive. */
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Only invoices where someone overrode a flag. */
  hasOverrides: z.boolean().optional(),
  /** Only invoices with an open blocking flag. */
  hasOpenBlocking: z.boolean().optional(),
  /** Order of the rows (optional; newest first when absent). */
  sort: InvoiceSort.optional(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(200).default(50),
});
export type AuditInvoiceListQuery = z.input<typeof AuditInvoiceListQuery>;

export const AuditInvoiceList = z.object({
  rows: z.array(AuditInvoiceRow),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type AuditInvoiceList = z.infer<typeof AuditInvoiceList>;

// ---------------------------------------------------------------------------------------------
// Screen 2 — one invoice, everything
// ---------------------------------------------------------------------------------------------

export const ControlCheck = z.object({
  /** Stable id the UI can key on, e.g. RELEASER_DID_NOT_APPROVE. */
  id: z.string(),
  label: z.string(),
  result: z.enum(["pass", "fail", "not_applicable"]),
  detail: z.string(),
});
export type ControlCheck = z.infer<typeof ControlCheck>;

export const TimelineEvent = z.object({
  id: z.number().int(),
  occurredAt: z.string(),
  action: z.string(),
  /** One sentence for the timeline: "Dev Malhotra (approver) approved step 1 on behalf of Ana Lee". */
  summary: z.string(),
  actor: Person,
  /** Their role when they acted (may differ from today's). */
  actorRoleAtTime: z.string(),
  onBehalfOf: Person.nullable(),
  entityType: z.string(),
  entityId: z.string(),
  paymentId: z.string().nullable(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  reason: z.string().nullable(),
  /** True for history reconstructed by the seed (not written live by the app). */
  imported: z.boolean(),
  requestId: z.string(),
});
export type TimelineEvent = z.infer<typeof TimelineEvent>;

export const AuditInvoiceDetail = z.object({
  invoice: z.object({
    invoiceId: z.string(),
    invoiceNumber: z.string().nullable(),
    status: z.string(),
    legacyStatus: z.string().nullable(),
    version: z.number().int(),
    source: z.string(),
    invoiceDate: z.string().nullable(),
    receivedDate: z.string().nullable(),
    dueDate: z.string().nullable(),
    currency: z.string().nullable(),
    subtotalCents: Cents.nullable(),
    totalCents: Cents.nullable(),
    totalCadCents: Cents.nullable(),
    fxRate: z.string().nullable(),
    shipToProvince: z.string().nullable(),
    isCreditNote: z.boolean(),
    poId: z.string().nullable(),
    contractId: z.string().nullable(),
    departmentId: z.string().nullable(),
    requester: Person.nullable(),
    vendor: z.object({ vendorId: z.string(), legalName: z.string(), status: z.string(), category: z.string() }).nullable(),
    vendorNameRaw: z.string().nullable(),
    createdAt: z.string(),
  }),
  /** The source file and what extraction read from it, before any human edit. */
  document: z.object({ documentId: z.string(), storageKey: z.string(), fileName: z.string().nullable(), sha256: z.string() }).nullable(),
  extraction: z.object({ raw: z.unknown().nullable(), confidence: z.unknown().nullable() }),
  lines: z.array(
    z.object({
      lineNo: z.number().int(),
      description: z.string(),
      lineType: z.string().nullable(),
      qty: z.string().nullable(),
      unitPriceCents: Cents.nullable(),
      amountCents: Cents,
      glAccount: z.object({ code: z.string(), name: z.string().nullable() }).nullable(),
      departmentId: z.string().nullable(),
      taxCodes: z.array(z.string()),
      codingSource: z.string().nullable(),
    }),
  ),
  taxes: z.array(z.object({ code: z.string().nullable(), label: z.string().nullable(), rate: z.string().nullable(), amountCents: Cents })),
  /** Every validation run, newest first, with the reference data the verdict was based on. */
  validationRuns: z.array(
    z.object({
      occurredAt: z.string(),
      invoiceVersion: z.number().int().nullable(),
      vendorId: z.string().nullable(),
      vendorMatch: z.unknown(),
      contractId: z.string().nullable(),
      fxRate: z.string().nullable(),
      totalCadCents: Cents.nullable(),
      blocking: z.boolean(),
      flags: z.array(z.object({ code: z.string(), severity: z.string() })),
    }),
  ),
  flags: z.array(
    z.object({
      flagId: z.number().int(),
      source: z.string(),
      code: z.string(),
      severity: z.string(),
      message: z.string(),
      evidence: z.record(z.string(), z.unknown()),
      status: z.string(),
      raisedAt: z.string(),
      resolvedBy: Person.nullable(),
      resolvedAt: z.string().nullable(),
      resolutionNote: z.string().nullable(),
      relatedInvoiceId: z.string().nullable(),
    }),
  ),
  approvals: z.array(
    z.object({
      planId: z.string(),
      attempt: z.number().int(),
      invoiceVersion: z.number().int(),
      outcome: z.string(),
      routedAt: z.string(),
      steps: z.array(
        z.object({
          seq: z.number().int(),
          role: z.string(),
          policyId: z.string().nullable(),
          policyVersion: z.number().int().nullable(),
          reasons: z.unknown(),
          assignedTo: Person.nullable(),
          actedBy: Person.nullable(),
          onBehalfOf: Person.nullable(),
          /** Name, role and limit WHEN they acted. */
          actedAs: z.unknown().nullable(),
          decision: z.string(),
          comment: z.string().nullable(),
          decidedAt: z.string().nullable(),
          acknowledgedFlags: z.unknown(),
        }),
      ),
    }),
  ),
  /** Payment ATTEMPTS, oldest first (a retry is a new attempt). */
  payments: z.array(
    z.object({
      paymentId: z.string(),
      attemptNo: z.number().int(),
      method: z.string(),
      status: z.string(),
      currency: z.string(),
      amountCents: Cents,
      amountCadCents: Cents,
      scheduledDate: z.string().nullable(),
      paidDate: z.string().nullable(),
      reference: z.string().nullable(),
      preparedBy: Person.nullable(),
      releasedBy: Person.nullable(),
      releasedAt: z.string().nullable(),
      settledAt: z.string().nullable(),
      failedAt: z.string().nullable(),
      failureCode: z.string().nullable(),
      failure: z.unknown().nullable(),
      cancelledAt: z.string().nullable(),
      cancelledBy: Person.nullable(),
      cancelReason: z.string().nullable(),
      holdReason: z.string().nullable(),
      bankAccount: z
        .object({
          version: z.number().int(),
          status: z.string(),
          currency: z.string(),
          institution: z.string().nullable(),
          last4: z.string(),
          changedAt: z.string().nullable(),
          channel: z.string().nullable(),
          requestedBy: Person.nullable(),
          verifiedBy: Person.nullable(),
          verifiedAt: z.string().nullable(),
        })
        .nullable(),
    }),
  ),
  /** Payments' urgency flags raised by this invoice's attempts (failed EFT, bank problems…). */
  paymentFlags: z.array(
    z.object({
      flagId: z.string(),
      paymentId: z.string(),
      urgency: z.string(),
      reasonCode: z.string(),
      message: z.string(),
      scope: z.string(),
      createdAt: z.string(),
      clearedBy: Person.nullable(),
      clearedAt: z.string().nullable(),
      clearNote: z.string().nullable(),
      clearedAutomatically: z.boolean(),
    }),
  ),
  /** Automatic control tests an auditor would otherwise do by hand. */
  controls: z.array(ControlCheck),
  /** Every audit event for the invoice and its payments, oldest first. */
  timeline: z.array(TimelineEvent),
});
export type AuditInvoiceDetail = z.infer<typeof AuditInvoiceDetail>;
