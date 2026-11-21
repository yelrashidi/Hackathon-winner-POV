import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DocumentReading, ExtractedDocument } from "../extraction";
import { InboxMessage, IntakeClassification } from "../intake";
import { ValidationInput } from "../validation";
import { llmExtractionSchema } from "@/server/features/extraction/prompt";
import { readDocument } from "@/server/features/extraction/read-document";
import { taxCodesFromCsv } from "@/server/features/extraction/tax-codes";
import { classifyEmail } from "@/server/features/intake/classify/classify";
import { DATASET_DIR, vendorDomainsFromCsv } from "@/server/features/intake/dataset/vendors";

const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const files = (dir: string) => readdirSync(dir, { withFileTypes: true })
  .filter((f) => f.isFile() && f.name.endsWith(".json")).map((f) => path.join(dir, f.name)).sort();
const extractionFiles = files("fixtures/extraction");
const intakeFiles = files("fixtures/intake");
const readings = extractionFiles.map((file) => ({ file, reading: DocumentReading.parse(json(file)) }));
const replySchema = llmExtractionSchema(taxCodesFromCsv());

describe("frozen intake and extraction hand-offs", () => {
  it("covers invoices, scans, signed credits and safe fallbacks", () => {
    expect(readings.some(({ reading: r }) => r.extracted?.documentType === "invoice" && r.extracted.lines.length > 0)).toBe(true);
    expect(readings.some(({ reading: r }) => r.signals.includes("DOC_NO_TEXT_LAYER") && r.extracted !== null)).toBe(true);
    const credit = readings.find(({ reading: r }) => r.extracted?.documentType === "credit_note")!.reading.extracted!;
    expect(credit.totalCents).toBeLessThan(0);
    expect(readings.some(({ reading: r }) => r.verdict === "bill" && r.extracted === null)).toBe(true);
    expect(readings.some(({ reading: r }) => r.verdict === "uncertain")).toBe(true);
    expect(intakeFiles.length).toBeGreaterThanOrEqual(8);
  });

  it.each(readings)("replays real raw extraction through the current reader: $file", async ({ reading }) => {
    const bytes = readFileSync(path.join(DATASET_DIR, "incoming_invoices", path.basename(reading.sourceRef)));
    const raw = reading.llmRaw === null ? null : replySchema.parse(reading.llmRaw);
    const actual = await readDocument({ sourceRef: reading.sourceRef, filename: reading.filename,
      mime: reading.filename.endsWith(".png") ? "image/png" : "application/pdf", bytes }, { llm: raw ? async () => raw : undefined });
    expect(actual).toEqual(reading);
    if (reading.extracted) {
      const extracted = ExtractedDocument.parse(reading.extracted);
      const mapped = ValidationInput.parse({ ...extracted, invoiceId: "CONTRACT-REPLAY", receivedDate: "2026-11-21" });
      expect(mapped.lines.map((l) => l.lineType)).toEqual(extracted.lines.map((l) => l.lineType));
      expect(mapped.totalCents).toBe(extracted.totalCents);
    }
  });

  it.each(intakeFiles)("replays the classifier with frozen document readings: %s", async (file) => {
    const key = path.basename(file);
    const message = InboxMessage.parse(json(path.join("fixtures/intake/messages", key)));
    const expected = IntakeClassification.parse(json(file));
    const reading = readings.find((r) => path.basename(r.file) === key)?.reading;
    const actual = await classifyEmail(message, {
      ctx: { knownVendorDomains: vendorDomainsFromCsv() },
      loadAttachment: async (_m, a) => readFileSync(path.join(DATASET_DIR, "incoming_invoices", path.basename(a.sourceRef))),
      readDocument: async (doc) => {
        if (!reading || doc.sourceRef !== reading.sourceRef) throw new Error("No frozen document reading for attachment");
        return reading;
      },
    });
    expect(actual.classification).toEqual(expected);
  });
});
