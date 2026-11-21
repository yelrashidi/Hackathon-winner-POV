import { eq } from "drizzle-orm";
import { SYSTEM_ACTOR, type Actor } from "@/contracts/actor";
import type { DocumentReading, ExtractedDocument } from "@/contracts/extraction";
import type { InboxMessage, IntakeClassification } from "@/contracts/intake";
import type { ValidationInputDraft } from "@/contracts/validation";
import { withAction } from "@/server/core/audit";
import { fire } from "@/server/core/fire";
import { getDb, type Db } from "@/server/db/client";
import { inboxMessages, invoices } from "@/server/db/schema";
import { ingestInvoice, type AnalysisResult } from "./ingest";

/**
 * The hand-off from intake + extraction (features 1–2, Arpan) into the database pipeline.
 *
 *   readingToValidationInput(message, reading)   pure mapping: extraction's fields already match
 *                                                ValidationInput, plus the intake facts (id, sender, received date)
 *   ingestFromIntake(message, result)            one email (classifyEmail's IntakeResult) → stored:
 *     - the email               → inbox_messages (with intake's decision and reason)
 *     - a readable bill         → ingestInvoice: saved, validated, coded, audited (InReview)
 *     - a bill nobody could read → invoice in ManualEntry (fire extractionFailed) — never a guess
 *     - anything else           → no invoice; the email keeps its reason
 * Idempotent: the invoice id is derived from (source, email id, attachment), so polling the same
 * email twice reports "already_ingested" instead of creating a duplicate.
 */

export interface IntakeIngestResult {
  classification: IntakeClassification;
  readings: DocumentReading[];
}

export type IntakeOutcome =
  | { sourceRef: string; outcome: "ingested"; invoiceId: string; analysis: AnalysisResult }
  | { sourceRef: string; outcome: "manual_entry"; invoiceId: string; reason: string }
  | { sourceRef: string; outcome: "already_ingested"; invoiceId: string }
  | { sourceRef: string; outcome: "not_ingested"; reason: string };

/** inbox_messages.id: the dataset's own email ids (as seeded), source-prefixed for everything else. */
export function inboxMessageId(message: Pick<InboxMessage, "source" | "externalId">): string {
  return message.source === "dataset" ? message.externalId : `${message.source}:${message.externalId}`;
}

/** Stable, readable invoice id for one attachment of one email. */
export function intakeInvoiceId(message: Pick<InboxMessage, "source" | "externalId">, sourceRef: string): string {
  const slug = (s: string) => s.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return `IN-${slug(inboxMessageId(message))}-${slug(sourceRef)}`;
}

/** The date part of intake's receivedAt (dataset: local time, Gmail: UTC). */
const receivedDate = (receivedAt: string) => receivedAt.slice(0, 10);

export function readingToValidationInput(message: InboxMessage, reading: DocumentReading & { extracted: ExtractedDocument }): ValidationInputDraft {
  const x = reading.extracted;
  return {
    invoiceId: intakeInvoiceId(message, reading.sourceRef),
    documentType: x.documentType === "credit_note" ? "credit_note" : "invoice",
    vendor: { nameRaw: x.vendor.nameRaw, gstHstNumber: x.vendor.gstHstNumber, qstNumber: x.vendor.qstNumber, province: x.vendor.province, country: x.vendor.country },
    senderEmail: message.fromAddress,
    invoiceNumber: x.invoiceNumber,
    invoiceDate: x.invoiceDate,
    dueDate: x.dueDate,
    receivedDate: receivedDate(message.receivedAt),
    currency: x.currency,
    paymentTermsDays: x.paymentTermsDays,
    poNumber: x.poNumber,
    contractRef: x.contractRef,
    creditNoteRef: x.creditNoteRef,
    billTo: x.billTo,
    shipToProvince: x.shipToProvince,
    lines: x.lines,
    taxes: x.taxes,
    subtotalCents: x.subtotalCents,
    totalCents: x.totalCents,
    statedFxRate: x.statedFxRate,
    remitTo: x.remitTo,
    // Intake does not capture who asked for it yet; the clerk sets it in review (editInvoice).
    departmentId: null,
    requesterId: null,
    confidence: x.confidence,
  };
}

export async function ingestFromIntake(
  message: InboxMessage,
  result: IntakeIngestResult,
  opts: { db?: Db; actor?: Actor; today?: string; documentIds?: Readonly<Record<string, string>> } = {},
): Promise<IntakeOutcome[]> {
  const db = opts.db ?? getDb();
  const actor = opts.actor ?? SYSTEM_ACTOR;
  const { classification, readings } = result;
  const msgId = inboxMessageId(message);

  // The email itself, once, with intake's verdict (the dataset seed may already have it).
  await db
    .insert(inboxMessages)
    .values({
      id: msgId,
      receivedAt: message.receivedAt,
      fromAddress: message.fromAddress,
      subject: message.subject,
      body: message.bodyText,
      classification: `${classification.decision}/${classification.kind}`,
      raw: { message, classification },
    })
    .onConflictDoUpdate({ target: inboxMessages.id, set: { classification: `${classification.decision}/${classification.kind}` } });

  const outcomes: IntakeOutcome[] = [];
  for (const reading of readings) {
    const sourceRef = reading.sourceRef;
    const isBill = classification.decision === "invoice" && classification.invoiceAttachments.includes(sourceRef) && reading.verdict === "bill";
    if (!isBill) {
      outcomes.push({ sourceRef, outcome: "not_ingested", reason: reading.verdict === "bill" ? classification.reason : reading.reason });
      continue;
    }
    const invoiceId = intakeInvoiceId(message, sourceRef);
    const [existing] = await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.id, invoiceId));
    if (existing) {
      outcomes.push({ sourceRef, outcome: "already_ingested", invoiceId });
      continue;
    }
    const provenance = { inboxMessageId: msgId, sourceRef, filename: reading.filename, intakeReason: classification.reason, readBy: reading.decidedBy, warnings: reading.extracted?.warnings ?? [] };
    const source = message.source === "upload" ? "upload" : "email";

    if (reading.extracted) {
      const analysis = await ingestInvoice(readingToValidationInput(message, reading as DocumentReading & { extracted: ExtractedDocument }), {
        source,
        actor,
        documentId: opts.documentIds?.[sourceRef] ?? null,
        today: opts.today,
        provenance,
        // extraction's whole reading (reason, signals, raw model reply) is the original evidence
        evidence: { reading },
        db,
      });
      outcomes.push({ sourceRef, outcome: "ingested", invoiceId, analysis });
      continue;
    }

    // A bill whose fields could not be read: a clerk enters it (state machine: Received → ManualEntry).
    const why = reading.error ? `Extraction could not read it (${reading.error}).` : "Extraction returned no fields.";
    await withAction(
      actor,
      async (action) => {
        await action.tx.insert(invoices).values({
          id: invoiceId,
          status: "Received",
          source,
          documentId: opts.documentIds?.[sourceRef] ?? null,
          receivedDate: receivedDate(message.receivedAt),
          extractionRaw: { reading },
        });
        await action.audit({
          action: "invoice.created",
          entityType: "invoice",
          entityId: invoiceId,
          invoiceId,
          after: { status: "Received", source, readable: false },
          reason: why,
          metadata: provenance,
        });
        await fire(action, invoiceId, "extractionFailed", { reason: why });
      },
      { db },
    );
    outcomes.push({ sourceRef, outcome: "manual_entry", invoiceId, reason: why });
  }

  // An "invoice" email whose bill attachments produced no reading at all still must not vanish.
  for (const ref of classification.invoiceAttachments) {
    if (!readings.some((r) => r.sourceRef === ref)) outcomes.push({ sourceRef: ref, outcome: "not_ingested", reason: "No document reading for this attachment." });
  }
  return outcomes;
}
