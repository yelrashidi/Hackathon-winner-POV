import { describe, expect, it, vi } from "vitest";
import type { gmail_v1 } from "@googleapis/gmail";
import type { GmailClient } from "../gmail/client";
import { pollGmail } from "../gmail/poll";

function mailbox(historyPages: gmail_v1.Schema$ListHistoryResponse[] = [], backfillPages: gmail_v1.Schema$ListMessagesResponse[] = []) {
  const historyList = vi.fn(async ({ pageToken }: { pageToken?: string }) => ({ data: historyPages[Number(pageToken ?? 0)]! }));
  const messageList = vi.fn(async ({ pageToken }: { pageToken?: string }) => ({ data: backfillPages[Number(pageToken ?? 0)]! }));
  const get = vi.fn(async ({ id }: { id: string }) => ({ data: {
    id, internalDate: "1795000000000", labelIds: ["INBOX"],
    payload: { headers: [{ name: "From", value: "vendor@example.test" }] },
  } }));
  const profile = vi.fn(async () => ({ data: { historyId: "999" } }));
  const client = { users: { getProfile: profile, history: { list: historyList }, messages: { list: messageList, get } } } as unknown as GmailClient;
  return { client, historyList, messageList, get, profile };
}

const history = (ids: string[], nextPageToken?: string): gmail_v1.Schema$ListHistoryResponse => ({
  historyId: "999", nextPageToken,
  history: [{ messagesAdded: ids.map((id) => ({ message: { id } })) }],
});

describe("Gmail polling delivery and cursor", () => {
  it("records a baseline without backfilling a personal inbox", async () => {
    const m = mailbox();
    expect(await pollGmail(m.client, { cursor: null })).toMatchObject({ messages: [], cursor: "999", note: "baseline" });
    expect(m.get).not.toHaveBeenCalled();
    expect(m.historyList).not.toHaveBeenCalled();
  });

  it("delivers every message when one history page exceeds maxMessages", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `mail-${i}`);
    const m = mailbox([history(ids)]);
    const result = await pollGmail(m.client, { cursor: "100", maxMessages: 2 });
    expect(result.messages.map((x) => x.externalId)).toEqual(ids);
    expect(result.cursor).toBe("999");
  });

  it("drains all history pages, including an empty page, and fetches repeated ids once", async () => {
    const m = mailbox([history(["a", "b"], "1"), history([], "2"), history(["b", "c"])]);
    const result = await pollGmail(m.client, { cursor: "100", maxMessages: 1 });
    expect(result.messages.map((x) => x.externalId)).toEqual(["a", "b", "c"]);
    expect(m.historyList.mock.calls.map(([args]) => args.pageToken)).toEqual([undefined, "1", "2"]);
    expect(m.get).toHaveBeenCalledTimes(3);
  });

  it("drains backfill pages oldest first before returning its baseline cursor", async () => {
    const m = mailbox([], [
      { messages: [{ id: "c" }, { id: "b" }], nextPageToken: "1" },
      { messages: [{ id: "b" }, { id: "a" }] },
    ]);
    const result = await pollGmail(m.client, { cursor: null, backfillQuery: "newer_than:1d", maxMessages: 2 });
    expect(result.messages.map((x) => x.externalId)).toEqual(["a", "b", "c"]);
    expect(result).toMatchObject({ cursor: "999", note: "backfill" });
    expect(m.messageList).toHaveBeenCalledTimes(2);
    expect(m.profile.mock.invocationCallOrder[0]).toBeLessThan(m.messageList.mock.invocationCallOrder[0]!);
  });

  it("returns no cursor to save if fetching any discovered message fails", async () => {
    const m = mailbox([history(["a", "b"])]);
    m.get.mockRejectedValueOnce(new Error("Gmail unavailable"));
    await expect(pollGmail(m.client, { cursor: "100" })).rejects.toThrow("Gmail unavailable");
  });

  it("does not return a cursor after an incomplete history traversal", async () => {
    const m = mailbox([history(["a"], "1")]);
    m.historyList.mockResolvedValueOnce({ data: history(["a"], "1") }).mockRejectedValueOnce(new Error("rate limited"));
    await expect(pollGmail(m.client, { cursor: "100" })).rejects.toThrow("rate limited");
    expect(m.get).not.toHaveBeenCalled();
  });
});
