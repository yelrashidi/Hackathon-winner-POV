import { z } from "zod";
import type { InboxMessageInput } from "@/contracts/intake";

/**
 * The dataset's `inbox/emails.json` → the intake contract. Hidden scoring data arrives in this
 * format, so it goes through exactly the same classifier and draft-bill path as live Gmail.
 * Attachments are file names under `incoming_invoices/`; that name is the `sourceRef`.
 */

export const DatasetEmail = z.object({
  email_id: z.string(),
  from_name: z.string().nullable().optional(),
  from_address: z.string(),
  to_address: z.string().nullable().optional(),
  subject: z.string().nullable().optional(),
  received_at: z.string(),
  body: z.string().nullable().optional(),
  attachments: z.array(z.string()).nullable().optional(),
});
export type DatasetEmail = z.infer<typeof DatasetEmail>;

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  txt: "text/plain",
};

export function mimeFromFilename(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

export function fromDatasetEmail(raw: unknown): InboxMessageInput {
  const e = DatasetEmail.parse(raw);
  return {
    source: "dataset",
    externalId: e.email_id,
    threadId: null,
    fromName: e.from_name ?? null,
    fromAddress: e.from_address,
    toAddress: e.to_address ?? null,
    subject: e.subject ?? "",
    receivedAt: e.received_at,
    bodyText: e.body ?? "",
    attachments: (e.attachments ?? []).map((filename) => ({
      filename,
      mimeType: mimeFromFilename(filename),
      sizeBytes: null,
      sourceRef: filename,
    })),
  };
}

/** Accepts the file as delivered: a bare array, or `{ emails: [...] }`. */
export function fromDatasetFile(json: unknown): InboxMessageInput[] {
  const list = Array.isArray(json) ? json : (json as { emails?: unknown[] })?.emails;
  if (!Array.isArray(list)) throw new Error("emails.json: expected an array of emails");
  return list.map(fromDatasetEmail);
}
