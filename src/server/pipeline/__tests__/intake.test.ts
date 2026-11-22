import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { DocumentReading } from "@/contracts/extraction";
import { InboxMessage, IntakeClassification } from "@/contracts/intake";
import type { Db } from "@/server/db/client";
import { createSeededDb } from "@/server/db/__tests__/helpers";
import { auditEvents, documents, invoiceLines, invoices } from "@/server/db/schema";
import { getInvoiceAuditDetail } from "@/server/features/audit";
import { DATASET_DIR } from "@/server/features/intake/dataset/vendors";
import { loadIncomingFixtures } from "@/server/features/validation/dataset/batch";
import { ingestFromIntake, intakeInvoiceId, readingToValidationInput } from "..";

/**
 * Intake + extraction (Arpan) → the database pipeline, on his real fixtures: the email
 * (fixtures/intake/messages), intake's verdict (fixtures/intake) and extraction's reading
 * (fixtures/extraction), matched by file name.
 */

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const read = (p: string) => JSON.parse(readFileSync(path.join(ROOT, p), "utf8"));
const CASES = readdirSync(path.join(ROOT, "fixtures/intake/messages"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => {
    const name = f.replace(/\.json$/, "");
    const reading = existsSync(path.join(ROOT, `fixtures/extraction/${f}`)) ? DocumentReading.parse(read(`fixtures/extraction/${f}`)) : null;
    return { name, message: InboxMessage.parse(read(`fixtures/intake/messages/${f}`)), classification: IntakeClassification.parse(read(`fixtures/intake/${f}`)), readings: reading ? [reading] : [] };
  });
const byName = (n: string) => CASES.find((c) => c.name === n)!;
const TODAY = "2026-11-02";

let db: Db;
let client: PGlite;
const outcomes = new Map<string, Awaited<ReturnType<typeof ingestFromIntake>>>();

beforeAll(async () => {
  ({ db, client } = await createSeededDb({ validateHistory: false }));
  await client.exec("SET ROLE ap_app");
  for (const c of CASES) outcomes.set(c.name, await ingestFromIntake(c.message, { classification: c.classification, readings: c.readings }, { db, today: TODAY }));
}, 120_000);

describe("intake → pipeline adapter", () => {
  it("has the fixtures it needs", () => {
    expect(CASES.map((c) => c.name)).toEqual(expect.arrayContaining(["vendor-invoice", "scanned-invoice", "credit-note", "manual-invoice", "uncertain-scan", "marketing"]));
  });

  it.each(["vendor-invoice", "scanned-invoice", "credit-note"])("%s: a readable bill is saved, validated and coded (InReview)", async (name) => {
    const [o] = outcomes.get(name)!;
    expect(o!.outcome).toBe("ingested");
    const id = (o as { invoiceId: string }).invoiceId;
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, id));
    const c = byName(name);
    expect(inv).toMatchObject({ status: "InReview", source: "email", invoiceNumber: c.readings[0]!.extracted!.invoiceNumber, totalCents: c.readings[0]!.extracted!.totalCents });
    expect(inv!.vendorId).not.toBeNull(); // validation matched the vendor
    expect((inv!.extractionRaw as { reading?: unknown }).reading).toBeTruthy(); // extraction's full reading kept as evidence
    const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, id));
    expect(lines.length).toBe(c.readings[0]!.extracted!.lines.length);
    expect(lines.every((l) => l.codingSource === "suggested")).toBe(true);
    const [created] = await db.select().from(auditEvents).where(eq(auditEvents.entityId, id)).orderBy(auditEvents.id).limit(1);
    expect(created!.action).toBe("invoice.created");
    expect(created!.metadata).toMatchObject({ inboxMessageId: c.message.externalId, sourceRef: c.readings[0]!.sourceRef });
  });

  it("Arpan's extraction gives the same validation flags as the hand-extracted invoice", () => {
    const hand = loadIncomingFixtures();
    let compared = 0;
    for (const name of ["vendor-invoice", "scanned-invoice", "credit-note"]) {
      const o = outcomes.get(name)![0] as { analysis: { result: { flags: { code: string }[] } } };
      const number = byName(name).readings[0]!.extracted!.invoiceNumber;
      const twin = hand.find((h) => h.fixture.input.invoiceNumber === number);
      if (!twin) continue;
      compared++;
      expect([...new Set(o.analysis.result.flags.map((f) => f.code))].sort()).toEqual([...(twin.fixture.expectedCodes ?? [])].sort());
    }
    expect(compared).toBeGreaterThan(0);
  });

  it("a bill extraction could not read becomes a ManualEntry invoice, not a guess", async () => {
    const [o] = outcomes.get("manual-invoice")!;
    expect(o!.outcome).toBe("manual_entry");
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, (o as { invoiceId: string }).invoiceId));
    expect(inv).toMatchObject({ status: "ManualEntry", totalCents: null, vendorId: null });
    const actions = (await db.select({ a: auditEvents.action, after: auditEvents.after }).from(auditEvents).where(eq(auditEvents.invoiceId, inv!.id)).orderBy(auditEvents.id)).map((e) => e.a);
    expect(actions).toEqual(["invoice.created", "invoice.status_changed"]);
  });

  it("an uncertain scan and non-invoice emails create no invoice, and keep their reason", async () => {
    for (const name of ["uncertain-scan", "marketing", "statement", "missing-attachment"]) {
      const c = byName(name);
      if (!c) continue;
      for (const o of outcomes.get(name)!) expect(o.outcome).toBe("not_ingested");
      const rows = await client.query<{ classification: string }>(`SELECT classification FROM inbox_messages WHERE id = '${c.message.externalId}'`);
      expect(rows.rows[0]!.classification).toBe(`${c.classification.decision}/${c.classification.kind}`);
      // No invoice.created event traces back to THIS case's intake decision. (The fixtures reuse one
      // email, EM-011, for both "scan read" and "scan unreadable", so counting by email id is wrong.)
      const n = await client.query<{ n: number }>(
        `SELECT count(*)::int n FROM audit_events WHERE action = 'invoice.created' AND metadata->>'intakeReason' = '${c.classification.reason.replace(/'/g, "''")}'`,
      );
      expect(n.rows[0]!.n).toBe(0);
    }
  });

  it("polling the same email again does not create a duplicate", async () => {
    const c = byName("vendor-invoice");
    const again = await ingestFromIntake(c.message, { classification: c.classification, readings: c.readings }, { db, today: TODAY });
    expect(again[0]!.outcome).toBe("already_ingested");
    const n = await client.query<{ n: number }>(`SELECT count(*)::int n FROM invoices WHERE id = '${intakeInvoiceId(c.message, c.readings[0]!.sourceRef)}'`);
    expect(n.rows[0]!.n).toBe(1);
  });

  it("with the attachment bytes, the bill links to its source file (sha256), up to the auditor's view", async () => {
    const c = byName("vendor-invoice");
    const message = { ...c.message, externalId: "EM-T-DOC" }; // a fresh email carrying the same PDF
    const bytes = readFileSync(path.join(DATASET_DIR, "incoming_invoices", c.readings[0]!.sourceRef));
    const attachments = { [c.readings[0]!.sourceRef]: { bytes, storageKey: `incoming_invoices/${c.readings[0]!.sourceRef}` } };
    const [o] = await ingestFromIntake(message, { classification: c.classification, readings: c.readings }, { db, today: TODAY, attachments });
    const id = (o as { invoiceId: string }).invoiceId;
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, id));
    const [doc] = await db.select().from(documents).where(eq(documents.id, inv!.documentId!));
    expect(doc).toMatchObject({ inboxMessageId: "EM-T-DOC", sha256: createHash("sha256").update(bytes).digest("hex"), storageKey: `incoming_invoices/${c.readings[0]!.sourceRef}`, mime: "application/pdf" });
    const [created] = await db.select().from(auditEvents).where(eq(auditEvents.entityId, id)).orderBy(auditEvents.id).limit(1);
    expect(created!.metadata).toMatchObject({ documentId: doc!.id });
    const detail = await getInvoiceAuditDetail({ userId: "U040", role: "auditor" }, id, { db });
    expect(detail.document).toMatchObject({ documentId: doc!.id, sha256: doc!.sha256 });
  });

  it("a retry after a failed save reuses the document row instead of adding another", async () => {
    const c = byName("manual-invoice");
    const message = { ...c.message, externalId: "EM-T-RETRY" };
    const attachments = { [c.readings[0]!.sourceRef]: { bytes: Buffer.from("same bytes") } };
    await ingestFromIntake(message, { classification: c.classification, readings: c.readings }, { db, today: TODAY, attachments });
    await ingestFromIntake(message, { classification: c.classification, readings: c.readings }, { db, today: TODAY, attachments });
    const n = await client.query<{ n: number }>(`SELECT count(*)::int n FROM documents WHERE inbox_message_id = 'EM-T-RETRY'`);
    expect(n.rows[0]!.n).toBe(1);
  });

  it("the mapping copies every field validation reads and adds the intake facts", () => {
    const c = byName("credit-note");
    const input = readingToValidationInput(c.message, c.readings[0] as never);
    expect(input).toMatchObject({ documentType: "credit_note", senderEmail: c.message.fromAddress, receivedDate: c.message.receivedAt.slice(0, 10), requesterId: null });
    expect(input.totalCents).toBeLessThan(0);
  });
});
