/**
 * Regenerates fixtures/vendors/ from a REAL run (docs/rules/contracts.md: fixtures come from real
 * runs): in-process Postgres → migrate → seed → the vendor flows → read the vendor screens.
 * Whoever builds the vendor pages works from these files without a database.
 *   npx tsx scripts/vendor-fixtures.ts
 *
 * The story in the files: an invoice from an unknown vendor arrives → a clerk onboards the vendor
 * from it, with its bank details → the vendor and its bank account wait for a second person.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Actor } from "@/contracts/actor";
import { VendorDetail, VendorDraft, VendorList } from "@/contracts/vendor";
import { createSeededDb } from "@/server/db/__tests__/helpers";
import { loadIncomingFixtures } from "@/server/features/validation/dataset/batch";
import { getVendorDetail, listVendors, onboardVendor, vendorDraftFromInvoice } from "@/server/features/vendors";
import { ingestInvoice } from "@/server/pipeline";

const TODAY = "2026-11-02";
const CLERK: Actor = { userId: "U004", role: "ap_clerk" };
const FM: Actor = { userId: "U003", role: "finance_manager" };
const UNKNOWN_VENDOR_INVOICE = "IN-invoice-4443";

const out = path.resolve("fixtures/vendors");
mkdirSync(out, { recursive: true });
const write = (name: string, data: unknown) => {
  writeFileSync(path.join(out, name), `${JSON.stringify(data, null, 2)}\n`);
  console.log(`wrote fixtures/vendors/${name}`);
};

const { db, client } = await createSeededDb({ validateHistory: false });
await client.exec("SET ROLE ap_app");
for (const { fixture } of loadIncomingFixtures()) await ingestInvoice(fixture.input, { source: "email", today: TODAY, db });

const draft = VendorDraft.parse(await vendorDraftFromInvoice(CLERK, UNKNOWN_VENDOR_INVOICE, { db }));
write("vendor-draft.json", draft);

const { vendorId } = await onboardVendor(
  CLERK,
  {
    legalName: draft.legalName ?? "New vendor",
    category: "Freight & Carriers",
    gstHstNumber: draft.gstHstNumber,
    qstNumber: draft.qstNumber,
    apContactEmail: draft.apContactEmail,
    provinceOrState: draft.provinceOrState,
    fromInvoiceId: UNKNOWN_VENDOR_INVOICE,
    bankAccount: { institution: "003", transit: "10052", account: "4410025617", channel: "phone_callback_verified" },
  },
  { db, today: TODAY },
);

// What the finance manager sees: the list, and the new vendor waiting for their approval + verification.
write("vendor-list.json", VendorList.parse(await listVendors(FM, {}, { db, today: TODAY })));
write("vendor-detail.json", VendorDetail.parse(await getVendorDetail(FM, vendorId, { db })));
// The same vendor seen by the clerk who onboarded it: approve / verify are greyed out, with the reason.
write("vendor-detail-as-onboarder.json", VendorDetail.parse(await getVendorDetail(CLERK, vendorId, { db })));
process.exit(0);
