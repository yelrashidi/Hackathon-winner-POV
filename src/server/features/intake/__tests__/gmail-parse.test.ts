import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InboxMessage } from "@/contracts/intake";
import { fromDatasetFile } from "../dataset/emails";
import { extractBody, parseAddress, toInboxMessage } from "../gmail/parse";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

const gmailMessage = {
  id: "18c0ffee",
  threadId: "18c0ffee",
  internalDate: "1795000000000",
  labelIds: ["INBOX", "UNREAD"],
  payload: {
    mimeType: "multipart/mixed",
    headers: [
      { name: "From", value: '"Acme Freight AR" <AR@Acme-Freight.example>' },
      { name: "To", value: "me@gmail.com" },
      { name: "Subject", value: "Invoice INV-1 attached" },
    ],
    parts: [
      {
        partId: "0", mimeType: "multipart/alternative",
        parts: [
          { partId: "0.0", mimeType: "text/plain", body: { data: b64("Please find invoice INV-1 attached.") } },
          { partId: "0.1", mimeType: "text/html", body: { data: b64("<p>Please find <b>invoice</b></p>") } },
        ],
      },
      { partId: "1", mimeType: "application/pdf", filename: "INV-1.pdf", body: { attachmentId: "ATT-1", size: 2400 } },
      { partId: "2", mimeType: "image/png", filename: "logo.png", body: { data: b64("png"), size: 3 } },
    ],
  },
};

describe("gmail parse", () => {
  it("maps a multipart Gmail message to a valid InboxMessage", () => {
    const m = InboxMessage.parse(toInboxMessage(gmailMessage));
    expect(m).toMatchObject({
      source: "gmail", externalId: "18c0ffee", fromName: "Acme Freight AR",
      fromAddress: "ar@acme-freight.example", toAddress: "me@gmail.com",
      subject: "Invoice INV-1 attached", bodyText: "Please find invoice INV-1 attached.",
      receivedAt: new Date(1795000000000).toISOString(),
    });
    expect(m.attachments).toEqual([
      { filename: "INV-1.pdf", mimeType: "application/pdf", sizeBytes: 2400, sourceRef: "ATT-1" },
      { filename: "logo.png", mimeType: "image/png", sizeBytes: 3, sourceRef: "part:2" },
    ]);
  });

  it("falls back to stripped HTML when there is no text part", () => {
    expect(extractBody({ mimeType: "text/html", body: { data: b64("<div>Facture&nbsp;4443</div><br>Merci") } }))
      .toMatch(/^Facture 4443\n+Merci$/);
  });

  it("returns an empty attachment list for a body-only email", () => {
    const m = toInboxMessage({ ...gmailMessage, payload: { mimeType: "text/plain", headers: [], body: { data: b64("hi") } } });
    expect(m.attachments).toEqual([]);
  });

  it.each([
    ["ar@x.example", { name: null, address: "ar@x.example" }],
    ["Billing <Billing@X.example>", { name: "Billing", address: "billing@x.example" }],
    ['"Doe, Jane" <jane@x.example>', { name: "Doe, Jane", address: "jane@x.example" }],
    [null, { name: null, address: "" }],
  ])("parses address %s", (raw, expected) => {
    expect(parseAddress(raw)).toEqual(expected);
  });
});

describe("dataset emails.json adapter", () => {
  const file = path.resolve("brim_ap_dataset/brim_ap_dataset/inbox/emails.json");
  const emails = fromDatasetFile(JSON.parse(readFileSync(file, "utf8"))).map((e) => InboxMessage.parse(e));

  it("maps every dataset email into the shared contract", () => {
    expect(emails.length).toBeGreaterThan(0);
    expect(new Set(emails.map((e) => e.externalId)).size).toBe(emails.length);
  });

  it("keeps emails without attachments (they are routed, not dropped)", () => {
    expect(emails.some((e) => e.attachments.length === 0)).toBe(true);
  });

  it("infers attachment mime type from the file name", () => {
    const types = new Set(emails.flatMap((e) => e.attachments.map((a) => a.mimeType)));
    expect(types.has("application/pdf")).toBe(true);
  });
});
