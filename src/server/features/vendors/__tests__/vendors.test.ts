import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/contracts/actor";
import { VendorDetail, VendorList } from "@/contracts/vendor";
import { Forbidden } from "@/server/core/authorize";
import type { Db } from "@/server/db/client";
import { createSeededDb } from "@/server/db/__tests__/helpers";
import { invoiceFlags, invoiceLines, invoices, users, vendorBankAccounts, vendors } from "@/server/db/schema";
import { loadIncomingFixtures } from "@/server/features/validation/dataset/batch";
import { acceptConfidentLines, codeInvoiceLine, editInvoice, ingestInvoice, submitForApproval } from "@/server/pipeline";
import {
  approveVendor,
  getVendorDetail,
  holdVendor,
  listVendors,
  onboardVendor,
  rejectBankChange,
  releaseVendorHold,
  requestBankChange,
  vendorConflicts,
  vendorDraftFromInvoice,
  VendorError,
  verifyBankChange,
} from "..";

/**
 * Feature 9 end to end on the seeded dataset, as the app's restricted DB role (ap_app).
 * People (users.csv): U001/U002 controllers, U003 the finance manager, U004/U005 AP clerks,
 * U006 the auditor, U007 an approver.
 */

const TODAY = "2026-11-02";
const CTRL: Actor = { userId: "U001", role: "controller_admin" };
const CTRL2: Actor = { userId: "U002", role: "controller_admin" };
const FM: Actor = { userId: "U003", role: "finance_manager" };
const CLERK: Actor = { userId: "U004", role: "ap_clerk" };
const CLERK2: Actor = { userId: "U005", role: "ap_clerk" };
const AUDITOR: Actor = { userId: "U006", role: "auditor" };
const APPROVER: Actor = { userId: "U007", role: "approver" };
const opts = () => ({ db, today: TODAY });

let db: Db;
let client: PGlite;
const q = async <T>(sql: string) => (await client.query<T>(sql)).rows;

/** The incoming invoices these tests use (each shows a vendor-master problem, or none). */
const USED = {
  riverbend: "IN-riverbendcaterin-1739", // V054 pending review → VENDOR_NOT_ACTIVE
  blueHeron: "IN-invoice-4443", // not in the vendor master → VENDOR_UNKNOWN
  zephyr: "IN-zephyrdataservic-7590", // not in the vendor master → VENDOR_UNKNOWN
  cascadia: "IN-cascadiacartagel-1625", // remit-to = a bank change nobody verified → BANK_ACCOUNT_UNVERIFIED
  placeMontRoyal: "IN-placemontroyalim-inv-053", // clean
  queenStreet: "IN-invoice-002935", // clean, $18,758 → needs the finance manager's step
};

/** code → status of the invoice's validation flags. */
async function flagsOf(invoiceId: string): Promise<Record<string, string>> {
  const rows = await db.select({ code: invoiceFlags.code, status: invoiceFlags.status }).from(invoiceFlags).where(eq(invoiceFlags.invoiceId, invoiceId));
  return Object.fromEntries(rows.map((r) => [r.code, r.status]));
}
const vendorOf = async (invoiceId: string) => (await db.select({ v: invoices.vendorId }).from(invoices).where(eq(invoices.id, invoiceId)))[0]!.v!;
const statusOf = async (vendorId: string) => (await db.select({ s: vendors.status }).from(vendors).where(eq(vendors.id, vendorId)))[0]!.s;
/** Runs an action expected to be refused; returns the VendorError. */
async function refused(p: Promise<unknown>): Promise<VendorError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(VendorError);
  return err as VendorError;
}
const codesOf = (e: VendorError) => e.reasons.map((r) => r.code);
const deniedCount = async (attempted: string) => (await q<{ n: number }>(`SELECT count(*)::int n FROM audit_events WHERE action = 'authz.denied' AND metadata->>'attempted' = '${attempted}'`))[0]!.n;

beforeAll(async () => {
  ({ db, client } = await createSeededDb({ validateHistory: false }));
  await client.exec("SET ROLE ap_app");
  const wanted = new Set(Object.values(USED));
  for (const { fixture } of loadIncomingFixtures()) if (wanted.has(fixture.input.invoiceId)) await ingestInvoice(fixture.input, { source: "email", today: TODAY, db });
}, 120_000);

describe("who can see the vendor master", () => {
  it("clerk, finance manager, controller and auditor can; the list matches its contract", async () => {
    for (const a of [CLERK, FM, CTRL, AUDITOR]) {
      const list = await listVendors(a, {}, opts());
      expect(VendorList.safeParse(list).success).toBe(true);
      expect(list.total).toBe(56);
    }
  });

  it("employees and approvers are refused, and the attempt is audited", async () => {
    const before = await deniedCount("vendor.view");
    const [emp] = await q<{ id: string }>("SELECT id FROM users WHERE role = 'employee' AND status = 'active' ORDER BY id LIMIT 1");
    await expect(listVendors({ userId: emp!.id, role: "employee" }, {}, opts())).rejects.toBeInstanceOf(Forbidden);
    await expect(getVendorDetail(APPROVER, "V001", { db })).rejects.toBeInstanceOf(Forbidden);
    expect(await deniedCount("vendor.view")).toBe(before + 2);
  });

  it("filters, search and counts", async () => {
    const pending = await listVendors(CLERK, { status: "pending_review" }, opts());
    expect(pending.rows.map((r) => r.vendorId).sort()).toEqual(["V054", "V055", "V056"]);
    expect(pending.counts).toMatchObject({ pending_review: 3, on_hold: 1, active: 52 });
    const found = await listVendors(CLERK, { search: "riverbend" }, opts());
    expect(found.rows.map((r) => r.vendorId)).toEqual(["V054"]);
    expect(found.rows[0]!.openInvoices).toBe(1);
  });

  it("the auditor reads everything but can press nothing", async () => {
    const d = await getVendorDetail(AUDITOR, "V054", { db });
    expect(VendorDetail.safeParse(d).success).toBe(true);
    expect(Object.values(d.allowedActions).every((a) => !a.allowed && a.reason)).toBe(true);
    await expect(holdVendor(AUDITOR, "V054", { reason: "x" }, opts())).rejects.toBeInstanceOf(Forbidden);
    await expect(onboardVendor(AUDITOR, { legalName: "X", category: "Travel" }, opts())).rejects.toBeInstanceOf(Forbidden);
    await expect(verifyBankChange(AUDITOR, "V054", opts())).rejects.toBeInstanceOf(Forbidden);
  });
});

describe("approving a vendor pending review", () => {
  it("an AP clerk cannot approve (role); the finance manager can, and the invoice's flag clears itself", async () => {
    expect(await flagsOf(USED.riverbend)).toMatchObject({ VENDOR_NOT_ACTIVE: "open" });
    await expect(approveVendor(CLERK, "V054", {}, opts())).rejects.toBeInstanceOf(Forbidden);
    const r = await approveVendor(FM, "V054", { note: "W-9 and insurance certificate on file." }, opts());
    expect(r).toMatchObject({ vendorId: "V054", status: "active", revalidatedInvoices: [USED.riverbend] });
    expect(await statusOf("V054")).toBe("active");
    expect(await flagsOf(USED.riverbend)).toMatchObject({ VENDOR_NOT_ACTIVE: "resolved" });
    // Approving twice is a state error, not a crash.
    expect((await refused(approveVendor(CTRL, "V054", {}, opts()))).status).toBe(409);
  });
});

describe("onboarding a vendor nobody knew (VENDOR_UNKNOWN)", () => {
  let blueHeron: string;

  it("the form comes prefilled from the invoice", async () => {
    const draft = await vendorDraftFromInvoice(CLERK, USED.blueHeron, { db });
    expect(draft).toMatchObject({ fromInvoiceId: USED.blueHeron, legalName: "Blue Heron Couriers" });
    await expect(vendorDraftFromInvoice(APPROVER, USED.blueHeron, { db })).rejects.toBeInstanceOf(Forbidden);
  });

  it("a clerk onboards it: pending review, audited, and the invoice now matches it", async () => {
    expect(await flagsOf(USED.blueHeron)).toMatchObject({ VENDOR_UNKNOWN: "open" });
    const draft = await vendorDraftFromInvoice(CLERK, USED.blueHeron, { db });
    const r = await onboardVendor(
      CLERK,
      { legalName: draft.legalName!, category: "Freight & Carriers", gstHstNumber: draft.gstHstNumber, qstNumber: draft.qstNumber, apContactEmail: draft.apContactEmail, provinceOrState: draft.provinceOrState, fromInvoiceId: USED.blueHeron },
      opts(),
    );
    blueHeron = r.vendorId;
    expect(r).toMatchObject({ vendorId: "V057", status: "pending_review" });
    expect(r.revalidatedInvoices).toContain(USED.blueHeron);
    expect(await vendorOf(USED.blueHeron)).toBe("V057");
    expect(await flagsOf(USED.blueHeron)).toMatchObject({ VENDOR_UNKNOWN: "resolved", VENDOR_NOT_ACTIVE: "open" });
    const [created] = await q<{ actor_id: string; after: { legalName: string } }>(`SELECT actor_id, after FROM audit_events WHERE action = 'vendor.created' AND entity_id = 'V057'`);
    expect(created).toMatchObject({ actor_id: "U004", after: { legalName: "Blue Heron Couriers" } });
  });

  it("the finance manager approves it → the invoice's last vendor flag clears", async () => {
    await approveVendor(FM, blueHeron, {}, opts());
    expect(await flagsOf(USED.blueHeron)).toMatchObject({ VENDOR_UNKNOWN: "resolved", VENDOR_NOT_ACTIVE: "resolved" });
    const d = await getVendorDetail(FM, blueHeron, { db });
    expect(d.vendor).toMatchObject({ status: "active", onboardedBy: { userId: "U004" }, approvedBy: { userId: "U003" } });
    expect(d.timeline.map((e) => e.summary).join("\n")).toMatch(/onboarded vendor Blue Heron Couriers \(V057\)[\s\S]*pending review → active/);
  });

  it("whoever onboarded a vendor cannot approve it (two people), and the refusal is audited", async () => {
    const r = await onboardVendor(FM, { legalName: "Zephyr Data Services Inc.", category: "Software & SaaS", fromInvoiceId: USED.zephyr }, opts());
    const before = await deniedCount("vendor.approve");
    const err = await refused(approveVendor(FM, r.vendorId, {}, opts()));
    expect(err.status).toBe(403);
    expect(codesOf(err)).toEqual(["ONBOARDED_IT"]);
    expect(await deniedCount("vendor.approve")).toBe(before + 1);
    expect((await getVendorDetail(FM, r.vendorId, { db })).allowedActions.approve).toMatchObject({ allowed: false });
    await approveVendor(CTRL, r.vendorId, {}, opts());
    expect(await statusOf(r.vendorId)).toBe("active");
  });

  it("the same vendor cannot be added twice (tax number or legal name)", async () => {
    const [v1] = await db.select().from(vendors).where(eq(vendors.id, "V001"));
    const byGst = await refused(onboardVendor(CLERK, { legalName: "Totally New Name Inc.", category: "Travel", gstHstNumber: v1!.gstHstNumber }, opts()));
    expect(byGst.status).toBe(409);
    expect(codesOf(byGst)).toEqual(["VENDOR_ALREADY_EXISTS"]);
    const byName = await refused(onboardVendor(CLERK, { legalName: "great lakes carriers incorporated", category: "Freight & Carriers" }, opts()));
    expect(codesOf(byName)).toEqual(["VENDOR_ALREADY_EXISTS"]);
    const bad = await refused(onboardVendor(CLERK, { legalName: "", category: "Travel" }, opts()));
    expect(bad.status).toBe(400);
  });
});

describe("holds", () => {
  it("anyone in finance can put a vendor on hold (with a reason); its open invoices get flagged", async () => {
    const vendorId = await vendorOf(USED.placeMontRoyal);
    expect((await refused(holdVendor(CLERK2, vendorId, { reason: " " }, opts()))).status).toBe(400);
    const r = await holdVendor(CLERK2, vendorId, { reason: "Vendor disputes the October invoices; pause until resolved." }, opts());
    expect(r).toMatchObject({ status: "on_hold", revalidatedInvoices: [USED.placeMontRoyal] });
    expect(await flagsOf(USED.placeMontRoyal)).toMatchObject({ VENDOR_NOT_ACTIVE: "open" });
  });

  it("only a manager lifts it; the flag clears and the reason is shown", async () => {
    const vendorId = await vendorOf(USED.placeMontRoyal);
    await expect(releaseVendorHold(CLERK2, vendorId, { reason: "done" }, opts())).rejects.toBeInstanceOf(Forbidden);
    await releaseVendorHold(FM, vendorId, { reason: "Dispute settled with the vendor on 2026-11-01." }, opts());
    expect(await statusOf(vendorId)).toBe("active");
    expect(await flagsOf(USED.placeMontRoyal)).toMatchObject({ VENDOR_NOT_ACTIVE: "resolved" });
    expect((await getVendorDetail(CLERK, vendorId, { db })).vendor.statusReason).toBe("Dispute settled with the vendor on 2026-11-01.");
  });

  it("lifting a hold never approves a vendor that was still pending review", async () => {
    await holdVendor(CLERK, "V055", { reason: "Missing insurance certificate." }, opts());
    await releaseVendorHold(CTRL, "V055", { reason: "Certificate received." }, opts());
    expect(await statusOf("V055")).toBe("pending_review");
  });

  it("a user on leave cannot act", async () => {
    await client.query("UPDATE users SET status = 'on_leave' WHERE id = 'U005'");
    const err = await refused(holdVendor(CLERK2, "V056", { reason: "x" }, opts()));
    expect(codesOf(err)).toEqual(["USER_NOT_ACTIVE"]);
    await db.update(users).set({ status: "active" }).where(eq(users.id, "U005"));
  });
});

describe("bank detail changes", () => {
  it("verifying the pending change the invoice pays to clears BANK_ACCOUNT_UNVERIFIED", async () => {
    const vendorId = await vendorOf(USED.cascadia);
    expect(await flagsOf(USED.cascadia)).toMatchObject({ BANK_ACCOUNT_UNVERIFIED: "open" });
    const [pending] = await db.select().from(vendorBankAccounts).where(and(eq(vendorBankAccounts.vendorId, vendorId), eq(vendorBankAccounts.status, "pending")));
    const verifier = pending!.requestedBy === "U003" ? CTRL : FM; // never the person who entered it
    const r = await verifyBankChange(verifier, vendorId, opts());
    expect(r).toMatchObject({ status: "verified", version: pending!.version });
    const statuses = await db.select({ v: vendorBankAccounts.version, s: vendorBankAccounts.status }).from(vendorBankAccounts).where(eq(vendorBankAccounts.vendorId, vendorId));
    expect(statuses.filter((x) => x.s === "verified")).toEqual([{ v: pending!.version, s: "verified" }]);
    expect(await flagsOf(USED.cascadia)).toMatchObject({ BANK_ACCOUNT_UNVERIFIED: "resolved" });
  });

  it("verifying a DIFFERENT account flags open invoices that still pay to the old one", async () => {
    const vendorId = await vendorOf(USED.cascadia);
    await requestBankChange(CLERK, vendorId, { institution: "006", transit: "33001", account: "40400040" }, opts());
    expect(await flagsOf(USED.cascadia)).not.toHaveProperty("BANK_DETAILS_MISMATCH");
    await verifyBankChange(CTRL, vendorId, opts());
    expect(await flagsOf(USED.cascadia)).toMatchObject({ BANK_DETAILS_MISMATCH: "open" });
  });

  it("a clerk requests new details: bad formats refused, one pending change at a time", async () => {
    const vendorId = await vendorOf(USED.queenStreet);
    const bad = await refused(requestBankChange(CLERK, vendorId, { institution: "1", transit: "22", account: "12" }, opts()));
    expect(codesOf(bad)).toEqual(["INVALID_INSTITUTION", "INVALID_TRANSIT", "INVALID_ACCOUNT_NUMBER"]);
    // Periodic re-verification: the vendor confirmed its account on a call-back, so it is re-entered
    // as a new version (the same account the invoice asks to be paid to) and needs a second person.
    const r = await requestBankChange(CLERK, vendorId, { institution: "003", transit: "14713", account: "7100 61421", channel: "phone_callback_verified" }, opts());
    expect(r).toMatchObject({ status: "pending", last4: "1421" });
    const again = await refused(requestBankChange(CLERK2, vendorId, { institution: "004", transit: "47721", account: "1111111" }, opts()));
    expect(codesOf(again)).toEqual(["CHANGE_ALREADY_PENDING"]);
  });

  it("screens never get the full account number", async () => {
    const vendorId = await vendorOf(USED.queenStreet);
    const full = await db.select({ account: vendorBankAccounts.account }).from(vendorBankAccounts).where(eq(vendorBankAccounts.vendorId, vendorId));
    const json = JSON.stringify(await getVendorDetail(FM, vendorId, { db }));
    for (const { account } of full) if (account && account.length > 4) expect(json).not.toContain(account);
    expect(json).toContain('"last4":"1421"');
  });

  it("a clerk cannot verify; the finance manager verifies the clerk's change", async () => {
    const vendorId = await vendorOf(USED.queenStreet);
    await expect(verifyBankChange(CLERK2, vendorId, opts())).rejects.toBeInstanceOf(Forbidden);
    const r = await verifyBankChange(FM, vendorId, opts());
    expect(r).toMatchObject({ status: "verified", last4: "1421" });
    const d = await getVendorDetail(CTRL, vendorId, { db });
    expect(d.bankAccounts[0]).toMatchObject({ status: "verified", requestedBy: { userId: "U004" }, verifiedBy: { userId: "U003" }, channel: "phone_callback_verified" });
    expect(d.bankAccounts.slice(1).every((b) => b.status !== "verified")).toBe(true);
    expect(d.timeline.map((e) => e.summary).join("\n")).toMatch(/verified bank account V\d+#\d+ \(••1421\)/);
  });

  it("whoever entered the details cannot verify them — in the service AND in the database", async () => {
    const vendorId = await vendorOf(USED.placeMontRoyal);
    await requestBankChange(FM, vendorId, { institution: "010", transit: "00011", account: "55500011" }, opts());
    const err = await refused(verifyBankChange(FM, vendorId, opts()));
    expect(err.status).toBe(403);
    expect(codesOf(err)).toEqual(["ENTERED_IT"]);
    expect((await getVendorDetail(FM, vendorId, { db })).allowedActions.verifyBankChange).toMatchObject({ allowed: false });
    // Even a direct UPDATE that skips the service is stopped by the CHECK constraint.
    await expect(client.query(`UPDATE vendor_bank_accounts SET status = 'pending', verified_by = 'U003' WHERE vendor_id = '${vendorId}' AND status = 'pending'`)).rejects.toThrow(/two_people/);
  });

  it("a pending change can be rejected, with a reason", async () => {
    const vendorId = await vendorOf(USED.placeMontRoyal);
    expect((await refused(rejectBankChange(CTRL2, vendorId, { reason: "" }, opts()))).status).toBe(400);
    const r = await rejectBankChange(CTRL2, vendorId, { reason: "Vendor confirmed by phone they did not change banks." }, opts());
    expect(r.status).toBe("rejected");
    expect(codesOf(await refused(verifyBankChange(CTRL, vendorId, opts())))).toEqual(["NO_PENDING_CHANGE"]);
  });
});

describe("approvals: who maintains a vendor may not approve its invoices", () => {
  it("vendorConflicts names the bank change's requester and verifier", async () => {
    const vendorId = await vendorOf(USED.queenStreet);
    const c = await vendorConflicts(db, vendorId);
    expect(c.map((x) => x.userId).sort()).toEqual(["U003", "U004"]);
    expect(c.find((x) => x.userId === "U003")!.reason).toMatch(/verified this vendor's bank change/);
  });

  it("submitting the invoice excludes them, and routing still finds approvers", async () => {
    const id = USED.queenStreet;
    await acceptConfidentLines(CLERK, id, { db });
    const open = await db.select().from(invoiceLines).where(and(eq(invoiceLines.invoiceId, id), eq(invoiceLines.codingSource, "suggested")));
    const [inv] = await db.select({ d: invoices.departmentId }).from(invoices).where(eq(invoices.id, id));
    for (const l of open) await codeInvoiceLine(CLERK, id, l.lineNo, { glAccount: l.glAccountCode ?? "6100", departmentId: l.departmentId ?? inv!.d ?? "D01", note: "Checked." }, { db });
    const [requester] = await q<{ id: string }>(`SELECT id FROM users WHERE role = 'employee' AND status = 'active' AND department_id = '${inv!.d ?? "D01"}' ORDER BY id LIMIT 1`);
    await editInvoice(CLERK2, id, { requesterId: requester!.id }, { today: TODAY, db });

    const plan = await submitForApproval(CLERK2, id, { db, now: new Date(`${TODAY}T14:00:00Z`) });
    const excluded = plan.excludedApprovers.filter((x) => x.kind === "conflict").map((x) => x.userId);
    expect(excluded).toEqual(expect.arrayContaining(["U003", "U004"]));
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.steps.some((s) => s.assignedTo === "U003" || s.assignedTo === "U004")).toBe(false);
  });
});
