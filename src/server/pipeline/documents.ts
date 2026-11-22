import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb, type Db } from "@/server/db/client";
import { documents } from "@/server/db/schema";
import { DATASET_DIR } from "@/server/features/validation/dataset/csv";

/**
 * Where an invoice's original file lives, so the review screen and the auditor can open the exact
 * bytes the numbers came from (documents.sha256 proves it is the same file).
 *
 *   storage key "incoming_invoices/<file>"   the dataset's incoming batch (read-only folder)
 *   storage key "uploads/<sha256>.<ext>"     a file a person uploaded, or a Gmail attachment the poller
 *                                            saved (UPLOAD_DIR, default .data/uploads; in Docker a volume
 *                                            shared by the app and the poller)
 *
 * TEMP: storage — a deployed app keeps uploads in object storage (Supabase Storage); only
 * saveUploadedDocument() and readDocumentFile() change.
 */

export const UPLOAD_DIR = process.env.UPLOAD_DIR ?? path.join(process.cwd(), ".data/uploads");

const EXT_BY_MIME: Record<string, string> = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg" };

/** Write a file into the uploads folder, named by its content, and return its storage key. */
export async function writeUploadFile(file: { bytes: Uint8Array; fileName: string; mime?: string | null }): Promise<{ storageKey: string; sha256: string }> {
  const sha256 = createHash("sha256").update(file.bytes).digest("hex");
  const ext = (file.mime && EXT_BY_MIME[file.mime]) ?? (path.extname(file.fileName).slice(1).toLowerCase() || "bin");
  const name = `${sha256}.${ext}`;
  await mkdir(UPLOAD_DIR, { recursive: true });
  await writeFile(path.join(UPLOAD_DIR, name), file.bytes);
  return { storageKey: `uploads/${name}`, sha256 };
}

export async function saveUploadedDocument(file: { bytes: Uint8Array; fileName: string; mime: string }, opts: { db?: Db } = {}): Promise<{ documentId: string; sha256: string }> {
  const db = opts.db ?? getDb();
  const { storageKey, sha256 } = await writeUploadFile(file);
  const [row] = await db.insert(documents).values({ storageKey, fileName: file.fileName, mime: file.mime, sha256 }).returning({ id: documents.id });
  return { documentId: row!.id, sha256 };
}

/** The original bytes of a stored document, or null when the file is not where its key says. */
export async function readDocumentFile(documentId: string, opts: { db?: Db } = {}): Promise<{ bytes: Buffer; fileName: string; mime: string } | null> {
  const db = opts.db ?? getDb();
  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));
  if (!doc) return null;
  const [area, ...rest] = doc.storageKey.split("/");
  const name = path.basename(rest.join("/"));
  const file =
    area === "incoming_invoices" ? path.join(DATASET_DIR, "incoming_invoices", name)
    : area === "uploads" ? path.join(UPLOAD_DIR, name)
    : null;
  if (!file) return null;
  try {
    const bytes = await readFile(file);
    return { bytes, fileName: doc.fileName ?? name, mime: doc.mime ?? mimeOf(name) };
  } catch {
    return null;
  }
}

function mimeOf(name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  return ext === "pdf" ? "application/pdf" : ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "application/octet-stream";
}
