import type { gmail_v1 } from "@googleapis/gmail";
import type { InboxMessageInput } from "@/contracts/intake";

/**
 * Pure mapping: one Gmail API message (format "full") → the intake contract. No network, no env,
 * so it is unit-tested with hand-built payloads (see __tests__/gmail-parse.test.ts).
 */

type Part = gmail_v1.Schema$MessagePart;

export function headerValue(part: Part | undefined, name: string): string | null {
  const wanted = name.toLowerCase();
  return part?.headers?.find((h) => h.name?.toLowerCase() === wanted)?.value ?? null;
}

/** `"Acme AR" <ar@acme.example>` → { name: "Acme AR", address: "ar@acme.example" }. */
export function parseAddress(raw: string | null): { name: string | null; address: string } {
  if (!raw) return { name: null, address: "" };
  const angle = raw.match(/^\s*(.*?)\s*<([^<>]+)>\s*$/);
  if (angle) {
    const name = angle[1]!.replace(/^"(.*)"$/, "$1").trim();
    return { name: name === "" ? null : name, address: angle[2]!.trim().toLowerCase() };
  }
  return { name: null, address: raw.trim().toLowerCase() };
}

function decodeBase64Url(data: string | null | undefined): string {
  return data ? Buffer.from(data, "base64url").toString("utf8") : "";
}

/** Depth-first walk of the MIME tree (multipart/mixed → multipart/alternative → text/plain …). */
function* walk(part: Part | undefined): Generator<Part> {
  if (!part) return;
  yield part;
  for (const child of part.parts ?? []) yield* walk(child);
}

function isAttachment(part: Part): boolean {
  return Boolean(part.filename && part.filename.trim() !== "");
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractBody(payload: Part | undefined): string {
  const parts = [...walk(payload)].filter((p) => !isAttachment(p));
  const plain = parts.find((p) => p.mimeType === "text/plain" && p.body?.data);
  if (plain) return decodeBase64Url(plain.body!.data).trim();
  const html = parts.find((p) => p.mimeType === "text/html" && p.body?.data);
  return html ? htmlToText(decodeBase64Url(html.body!.data)) : "";
}

export function toInboxMessage(msg: gmail_v1.Schema$Message): InboxMessageInput {
  if (!msg.id) throw new Error("Gmail message has no id");
  const payload = msg.payload ?? undefined;
  const from = parseAddress(headerValue(payload, "From"));
  const to = parseAddress(headerValue(payload, "To"));

  const attachments = [...walk(payload)].filter(isAttachment).map((p) => ({
    filename: p.filename!.trim(),
    mimeType: p.mimeType ?? "application/octet-stream",
    sizeBytes: p.body?.size ?? null,
    // Large attachments are fetched by id; tiny ones can be inline, addressed by MIME part id.
    sourceRef: p.body?.attachmentId ?? `part:${p.partId ?? ""}`,
  }));

  const internalMs = Number(msg.internalDate);
  return {
    source: "gmail",
    externalId: msg.id,
    threadId: msg.threadId ?? null,
    fromName: from.name,
    fromAddress: from.address,
    toAddress: to.address || null,
    subject: headerValue(payload, "Subject") ?? "",
    receivedAt: new Date(Number.isFinite(internalMs) ? internalMs : Date.now()).toISOString(),
    bodyText: extractBody(payload),
    attachments,
  };
}
