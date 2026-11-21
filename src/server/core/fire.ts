import { and, eq, sql } from "drizzle-orm";
import { invoiceFlags, invoices, type InvoiceStatus } from "@/server/db/schema";
import type { ActionContext } from "./audit";

/**
 * Foundation — the invoice state machine (docs/explainers/brim-ap-diagrams.md §1).
 * The ONLY code that writes `invoices.status` (CLAUDE.md hard rule 1).
 *
 *   await withAction(actor, async (ctx) => {
 *     …your change…
 *     await fire(ctx, invoiceId, "submit");
 *   });
 *
 * fire() locks the invoice row, checks the transition is legal and its guard holds, writes the
 * new status and the `invoice.status_changed` audit event — all inside the caller's transaction.
 * (CLAUDE.md writes it as fire(invoiceId, event, actor); here the actor and transaction travel
 * together in `ctx`, so the audit row can never be written outside the change's transaction.)
 */

export const INVOICE_EVENTS = [
  "extractionSucceeded",
  "extractionFailed",
  "markNotInvoice",
  "fieldsEntered",
  "fieldsEdited",
  "submit",
  "hold",
  "confirmDuplicate",
  "confirmPaidByCard",
  "holdCleared",
  "vendorRejected",
  "stepApproved",
  "stepRejected",
  "materialEdit",
  "schedule",
  "paymentSettled",
  "paymentFailed",
  "paymentCancelled",
] as const;
export type InvoiceEvent = (typeof INVOICE_EVENTS)[number];

export interface FireOptions {
  /** stepApproved: true when this was the last approval step. */
  isLastStep?: boolean;
  /** paymentSettled: true when the invoice is now paid in full. */
  fullyPaid?: boolean;
  /** Why (shown in the audit timeline): rejection comment, hold reason, … */
  reason?: string;
  metadata?: Record<string, unknown>;
}

type Target = InvoiceStatus | ((o: FireOptions) => InvoiceStatus);

/** from → event → to. Exactly the diagram; anything not listed is illegal. */
export const TRANSITIONS: Partial<Record<InvoiceStatus, Partial<Record<InvoiceEvent, Target>>>> = {
  Received: { extractionSucceeded: "InReview", extractionFailed: "ManualEntry", markNotInvoice: "Voided" },
  ManualEntry: { fieldsEntered: "InReview" },
  InReview: { fieldsEdited: "InReview", submit: "PendingApproval", hold: "OnHold", confirmDuplicate: "Voided", confirmPaidByCard: "Closed" },
  OnHold: { holdCleared: "InReview", vendorRejected: "Voided" },
  PendingApproval: {
    stepApproved: (o) => (o.isLastStep ? "Approved" : "PendingApproval"),
    stepRejected: "InReview",
    materialEdit: "InReview",
  },
  Approved: { schedule: "PaymentScheduled", materialEdit: "InReview" },
  PaymentScheduled: {
    paymentSettled: (o) => (o.fullyPaid ? "Paid" : "PaymentScheduled"),
    paymentFailed: "Approved",
    paymentCancelled: "Approved",
  },
};

/** Postgres error code, whichever driver (and wrapper) threw it. */
export function pgCode(err: unknown): string | undefined {
  for (let e: unknown = err; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

export class TransitionError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409,
  ) {
    super(message);
    this.name = "TransitionError";
  }
}

export async function fire(ctx: ActionContext, invoiceId: string, event: InvoiceEvent, opts: FireOptions = {}): Promise<{ from: InvoiceStatus; to: InvoiceStatus; version: number }> {
  const { tx } = ctx;
  // Lock the row: two clicks on "submit" serialize here instead of both passing the guard.
  const [inv] = await tx.select({ status: invoices.status, version: invoices.version }).from(invoices).where(eq(invoices.id, invoiceId)).for("update");
  if (!inv) throw new TransitionError(`Invoice ${invoiceId} does not exist.`, 404);
  const from = inv.status as InvoiceStatus;

  const target = TRANSITIONS[from]?.[event];
  if (!target) throw new TransitionError(`"${event}" is not allowed while the invoice is ${from}.`, 409);
  const to = typeof target === "function" ? target(opts) : target;

  // Guard: submit [no blocking flags] — validation's hasBlocking(), evaluated on the stored flags.
  if (event === "submit") {
    const [blocking] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(invoiceFlags)
      .where(and(eq(invoiceFlags.invoiceId, invoiceId), eq(invoiceFlags.status, "open"), eq(invoiceFlags.severity, "block")));
    if ((blocking?.n ?? 0) > 0) {
      throw new TransitionError(`The invoice has ${blocking!.n} open blocking flag(s); resolve or override them before submitting.`, 409);
    }
  }

  // A material edit voids approvals tied to the old version (6-approvals.md).
  const version = event === "materialEdit" ? inv.version + 1 : inv.version;
  try {
    await tx.update(invoices).set({ status: to, version, updatedAt: sql`now()` }).where(eq(invoices.id, invoiceId));
  } catch (err) {
    // invoices_vendor_number_uq: another invoice with this vendor + number is already in approval or paid.
    if (pgCode(err) === "23505") throw new TransitionError("Another invoice with the same vendor and invoice number is already in approval or paid — this looks like a duplicate.", 409);
    throw err;
  }

  await ctx.audit({
    action: "invoice.status_changed",
    entityType: "invoice",
    entityId: invoiceId,
    invoiceId,
    before: { status: from, version: inv.version },
    after: { status: to, version },
    reason: opts.reason ?? null,
    metadata: { event, ...(opts.isLastStep !== undefined ? { isLastStep: opts.isLastStep } : {}), ...(opts.fullyPaid !== undefined ? { fullyPaid: opts.fullyPaid } : {}), ...opts.metadata },
  });
  return { from, to, version };
}
