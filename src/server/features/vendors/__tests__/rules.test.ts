import { describe, expect, it } from "vitest";
import { checkActorActive, checkApprove, checkBankDecision, checkBankDetails, checkBankRequest, checkHold, checkReleaseHold, findExistingVendor, type VendorState } from "../rules";
import { nextVendorId } from "../service";

/** Feature 9's rules on plain data: an empty list means allowed. */

const codes = (rs: { code: string }[]) => rs.map((r) => r.code);
const jordan = { id: "U004", fullName: "Jordan Okafor" };
const elise = { id: "U003", fullName: "Elise Tremblay" };
const vendor = (status: VendorState["status"], onboardedBy: string | null = null): VendorState => ({ id: "V900", legalName: "Acme Freight", status, onboardedBy });

describe("the person acting", () => {
  it("only active users may act", () => {
    expect(checkActorActive({ fullName: "A", status: "active" })).toEqual([]);
    expect(codes(checkActorActive({ fullName: "A", status: "on_leave" }))).toEqual(["USER_NOT_ACTIVE"]);
    expect(codes(checkActorActive(undefined))).toEqual(["UNKNOWN_USER"]);
  });
});

describe("onboarding: is it already in the vendor master?", () => {
  const existing = [
    { id: "V001", legalName: "Polar Freight Lines Ltd.", gstHstNumber: "995133220 RT0001", qstNumber: null, apContactEmail: "ar@polarfreight.example" },
    { id: "V002", legalName: "Bureau Gagnon S.E.N.C.R.L.", gstHstNumber: null, qstNumber: "1234567890TQ0001", apContactEmail: null },
  ];
  const fresh = { legalName: "Acme Freight", gstHstNumber: null, qstNumber: null, apContactEmail: null };

  it("same GST/HST number (any spacing) → refused", () => {
    const r = findExistingVendor({ ...fresh, gstHstNumber: "995133220RT0001" }, existing);
    expect(codes(r.refusals)).toEqual(["VENDOR_ALREADY_EXISTS"]);
    expect(r.refusals[0]).toMatchObject({ status: 409, vendorId: "V001" });
  });
  it("same 9-digit business number with another program account → refused", () => {
    expect(codes(findExistingVendor({ ...fresh, gstHstNumber: "995133220 RT0002" }, existing).refusals)).toEqual(["VENDOR_ALREADY_EXISTS"]);
  });
  it("same QST number, or the same legal name (dots and case ignored) → refused", () => {
    expect(codes(findExistingVendor({ ...fresh, qstNumber: "1234567890 TQ 0001" }, existing).refusals)).toEqual(["VENDOR_ALREADY_EXISTS"]);
    expect(codes(findExistingVendor({ ...fresh, legalName: "polar freight lines ltd" }, existing).refusals)).toEqual(["VENDOR_ALREADY_EXISTS"]);
  });
  it("same email domain or a similar name → only a warning", () => {
    const r = findExistingVendor({ ...fresh, legalName: "Polar Freight Line", apContactEmail: "billing@polarfreight.example" }, existing);
    expect(r.refusals).toEqual([]);
    expect(codes(r.warnings).sort()).toEqual(["EMAIL_DOMAIN_IN_USE", "SIMILAR_VENDOR_NAME"]);
  });
  it("a free mail domain says nothing; a genuinely new vendor passes", () => {
    expect(findExistingVendor({ ...fresh, apContactEmail: "acme@gmail.com" }, [{ ...existing[0]!, apContactEmail: "x@gmail.com" }]).warnings).toEqual([]);
    expect(findExistingVendor(fresh, existing)).toEqual({ refusals: [], warnings: [] });
  });
});

describe("status changes", () => {
  it("approve: only a vendor pending review, and never by whoever onboarded it", () => {
    expect(checkApprove(vendor("pending_review", "U004"), elise)).toEqual([]);
    expect(checkApprove(vendor("pending_review", null), elise)).toEqual([]); // came with the dataset
    expect(checkApprove(vendor("pending_review", "U003"), elise)).toMatchObject([{ code: "ONBOARDED_IT", status: 403 }]);
    expect(checkApprove(vendor("active"), elise)).toMatchObject([{ code: "NOT_PENDING_REVIEW", status: 409 }]);
  });
  it("hold: needs a reason, and not twice", () => {
    expect(checkHold(vendor("active"), "Vendor under investigation")).toEqual([]);
    expect(checkHold(vendor("pending_review"), "Not approved yet")).toEqual([]);
    expect(codes(checkHold(vendor("active"), "  "))).toEqual(["REASON_REQUIRED"]);
    expect(codes(checkHold(vendor("on_hold"), "again"))).toEqual(["ALREADY_ON_HOLD"]);
  });
  it("lift a hold: only from on_hold, with a reason", () => {
    expect(checkReleaseHold(vendor("on_hold"), "Cleared by the controller")).toEqual([]);
    expect(codes(checkReleaseHold(vendor("active"), "x"))).toEqual(["NOT_ON_HOLD"]);
    expect(codes(checkReleaseHold(vendor("on_hold"), ""))).toEqual(["REASON_REQUIRED"]);
  });
});

describe("bank details", () => {
  const ok = { institution: "003", transit: "12345", account: "1234567" };
  it("formats: 3-digit institution, 5-digit transit, 7–12 digit account", () => {
    expect(checkBankDetails(ok)).toEqual([]);
    expect(codes(checkBankDetails({ institution: "3", transit: "1234", account: "12ab" }))).toEqual(["INVALID_INSTITUTION", "INVALID_TRANSIT", "INVALID_ACCOUNT_NUMBER"]);
  });
  it("one pending change at a time", () => {
    expect(checkBankRequest([{ version: 1, status: "verified", requestedBy: null }], ok)).toEqual([]);
    expect(codes(checkBankRequest([{ version: 2, status: "pending", requestedBy: "U004" }], ok))).toEqual(["CHANGE_ALREADY_PENDING"]);
  });
  it("verify: a second person; reject: anyone allowed, with a reason", () => {
    const pending = { version: 2, status: "pending", requestedBy: "U003" };
    expect(checkBankDecision(pending, jordan, "verify")).toEqual([]);
    expect(checkBankDecision(pending, elise, "verify")).toMatchObject([{ code: "ENTERED_IT", status: 403 }]);
    expect(checkBankDecision(pending, elise, "reject", "Withdrawn — typo")).toEqual([]);
    expect(codes(checkBankDecision(pending, jordan, "reject", ""))).toEqual(["REASON_REQUIRED"]);
    expect(codes(checkBankDecision(undefined, jordan, "verify"))).toEqual(["NO_PENDING_CHANGE"]);
  });
});

describe("vendor ids", () => {
  it("continue the dataset's numbering", () => {
    expect(nextVendorId(["V001", "V056", "V010"])).toBe("V057");
    expect(nextVendorId([])).toBe("V001");
    expect(nextVendorId(["V999", "LEGACY-1"])).toBe("V1000");
  });
});
