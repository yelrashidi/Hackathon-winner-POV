import { readFileSync } from "node:fs";
import path from "node:path";
import { InboxMessage } from "@/contracts/intake";
import type { Db } from "@/server/db/client";
import { classifyEmail } from "@/server/features/intake/classify/classify";
import { fromDatasetFile } from "@/server/features/intake/dataset/emails";
import { vendorDomainsFromCsv } from "@/server/features/intake/dataset/vendors";
import { DATASET_AS_OF, DATASET_DIR } from "@/server/features/validation/dataset/csv";
import { ingestFromIntake, type IntakeOutcome } from "@/server/pipeline";
import { createFrozenReader } from "./frozen-extraction";

/**
 * Demo only: the dataset's AP inbox (inbox/emails.json, 59 emails) through the REAL intake path,
 * exactly like scripts/intake-dataset.ts but offline: classifyEmail (rules) → frozen extraction
 * readings → ingestFromIntake → saved, validated, coded, audited. Emails that are not bills keep
 * intake's reason on inbox_messages; bills become invoices in review with their PDF linked.
 */
export async function loadDatasetInbox(db: Db, opts: { log?: (msg: string) => void } = {}): Promise<Record<IntakeOutcome["outcome"], number>> {
  const emails = fromDatasetFile(JSON.parse(readFileSync(path.join(DATASET_DIR, "inbox/emails.json"), "utf8"))).map((e) => InboxMessage.parse(e));
  const readDocument = createFrozenReader();
  const ctx = { knownVendorDomains: vendorDomainsFromCsv(path.join(DATASET_DIR, "data/vendors.csv")) };
  const tally: Record<IntakeOutcome["outcome"], number> = { ingested: 0, manual_entry: 0, already_ingested: 0, not_ingested: 0 };

  for (const message of emails) {
    const files = new Map<string, Uint8Array>();
    const result = await classifyEmail(message, {
      ctx,
      loadAttachment: async (_m, a) => {
        const bytes = readFileSync(path.join(DATASET_DIR, "incoming_invoices", path.basename(a.sourceRef)));
        files.set(a.sourceRef, bytes);
        return bytes;
      },
      readDocument,
    });
    const attachments = Object.fromEntries([...files].map(([ref, bytes]) => [ref, { bytes, storageKey: `incoming_invoices/${path.basename(ref)}` }]));
    const outcomes = await ingestFromIntake(message, result, { db, today: DATASET_AS_OF, attachments });
    for (const o of outcomes) tally[o.outcome]++;
  }
  opts.log?.(`inbox: ${emails.length} emails → ${JSON.stringify(tally)}`);
  return tally;
}
