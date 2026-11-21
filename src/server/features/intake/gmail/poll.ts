import { InboxMessage } from "@/contracts/intake";
import type { GmailClient } from "./client";
import { toInboxMessage } from "./parse";

/**
 * Incremental polling with Gmail's history id — a cursor into the mailbox's change log.
 *
 * - First run (no cursor): record the current history id and return nothing. We never backfill a
 *   personal inbox by accident; `backfillQuery` opts in explicitly (e.g. "newer_than:1d").
 * - Later runs: `history.list(startHistoryId)` returns only messages added to INBOX since the
 *   cursor, so each poll costs O(new mail), not O(inbox).
 * - Gmail keeps history for roughly a week; an expired cursor answers 404. We then reset to "now"
 *   and report it, rather than re-reading the whole inbox.
 *
 * Re-delivery is harmless: the store is unique on (source, externalId), so a message seen twice
 * (crash between fetch and cursor save) becomes one row.
 */

export interface PollResult {
  messages: InboxMessage[];
  /** Save this and pass it to the next poll. */
  cursor: string;
  /** Why this poll returned what it did, for logs and the dashboard. */
  note: "baseline" | "incremental" | "backfill" | "cursor_expired_reset";
  /** Messages Gmail returned that failed the contract — kept visible, never silently dropped. */
  rejected: { id: string; reason: string }[];
}

export interface PollOptions {
  cursor: string | null;
  /** Gmail search query for an explicit one-off backfill, e.g. "newer_than:1d". */
  backfillQuery?: string;
  /** Messages per backfill page, not a delivery cap. Every page is drained before advancing. */
  maxMessages?: number;
}

async function currentHistoryId(client: GmailClient): Promise<string> {
  const { data } = await client.users.getProfile({ userId: "me" });
  if (!data.historyId) throw new Error("Gmail profile returned no historyId");
  return data.historyId;
}

async function fetchMessages(client: GmailClient, ids: string[]) {
  const messages: InboxMessage[] = [];
  const rejected: PollResult["rejected"] = [];
  for (const id of ids) {
    const { data } = await client.users.messages.get({ userId: "me", id, format: "full" });
    // Our own sent mail and drafts are never supplier invoices.
    if (data.labelIds?.some((l) => l === "SENT" || l === "DRAFT")) continue;
    const parsed = InboxMessage.safeParse(toInboxMessage(data));
    if (parsed.success) messages.push(parsed.data);
    else rejected.push({ id, reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  }
  return { messages, rejected };
}

function isNotFound(err: unknown): boolean {
  const e = err as { code?: number; status?: number; response?: { status?: number } };
  return e?.code === 404 || e?.status === 404 || e?.response?.status === 404;
}

export async function pollGmail(client: GmailClient, opts: PollOptions): Promise<PollResult> {
  const max = opts.maxMessages ?? 50;

  if (opts.backfillQuery) {
    const cursor = await currentHistoryId(client);
    const ids = new Set<string>();
    let pageToken: string | undefined;
    do {
      const { data } = await client.users.messages.list({
        userId: "me", q: `in:inbox ${opts.backfillQuery}`, maxResults: max, pageToken,
      });
      for (const message of data.messages ?? []) if (message.id) ids.add(message.id);
      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken);
    return { ...(await fetchMessages(client, [...ids].reverse())), cursor, note: "backfill" };
  }

  if (!opts.cursor) {
    return { messages: [], rejected: [], cursor: await currentHistoryId(client), note: "baseline" };
  }

  const ids = new Set<string>();
  let cursor = opts.cursor;
  let pageToken: string | undefined;
  try {
    do {
      const { data } = await client.users.history.list({
        userId: "me", startHistoryId: opts.cursor, historyTypes: ["messageAdded"], labelId: "INBOX", pageToken,
      });
      for (const h of data.history ?? []) {
        for (const added of h.messagesAdded ?? []) if (added.message?.id) ids.add(added.message.id);
      }
      if (data.historyId) cursor = data.historyId;
      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    return { messages: [], rejected: [], cursor: await currentHistoryId(client), note: "cursor_expired_reset" };
  }

  // Gmail's historyId covers the whole change log, not just the first page or N messages.
  // Fetch every discovered id before returning a cursor the caller may save (BUG-Arpan-02).
  return { ...(await fetchMessages(client, [...ids])), cursor, note: "incremental" };
}

/** Raw bytes of one attachment, addressed by the `sourceRef` the parser produced. */
export async function fetchGmailAttachment(client: GmailClient, messageId: string, sourceRef: string): Promise<Buffer> {
  if (sourceRef.startsWith("part:")) {
    const partId = sourceRef.slice("part:".length);
    const { data } = await client.users.messages.get({ userId: "me", id: messageId, format: "full" });
    const stack = data.payload ? [data.payload] : [];
    while (stack.length) {
      const p = stack.pop()!;
      if (p.partId === partId && p.body?.data) return Buffer.from(p.body.data, "base64url");
      stack.push(...(p.parts ?? []));
    }
    throw new Error(`Inline attachment part ${partId} not found in message ${messageId}`);
  }
  const { data } = await client.users.messages.attachments.get({ userId: "me", messageId, id: sourceRef });
  if (!data.data) throw new Error(`Attachment ${sourceRef} of message ${messageId} has no data`);
  return Buffer.from(data.data, "base64url");
}
