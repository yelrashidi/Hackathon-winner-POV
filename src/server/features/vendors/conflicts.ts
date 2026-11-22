import { SYSTEM_USER_ID } from "@/contracts/actor";
import type { Executor } from "@/server/db/client";
import { bankVersions, vendorHistory } from "./shared";

/**
 * Who maintains this vendor in the vendor master, and so may NOT approve its invoices
 * (ApprovalInput.conflicts, src/contracts/approvals.ts). Keeping "set up the vendor / its bank
 * account" and "approve paying it" in different hands is the separation of duties that stops a
 * person paying a vendor they created or redirected.
 *
 *   - whoever onboarded the vendor, and whoever approved it
 *   - whoever requested, and whoever verified, its latest bank change
 *
 * Approvals then routes around them (escalating if needed). The system user is never listed.
 */
export async function vendorConflicts(db: Executor, vendorId: string | null): Promise<{ userId: string; reason: string }[]> {
  if (!vendorId) return [];
  const [history, versions] = await Promise.all([vendorHistory(db, vendorId), bankVersions(db, vendorId)]);
  const reasons = new Map<string, string[]>();
  const add = (userId: string | null, why: string) => {
    if (!userId || userId === SYSTEM_USER_ID) return;
    reasons.set(userId, [...(reasons.get(userId) ?? []), why]);
  };

  add(history.onboardedBy, `onboarded this vendor on ${history.onboardedOn}`);
  add(history.approvedBy, `approved this vendor on ${history.approvedOn}`);
  const latest = versions[0]; // newest version, whatever its status
  if (latest) {
    add(latest.requestedBy, `requested this vendor's bank change${latest.changedAt ? ` on ${latest.changedAt}` : ""}`);
    add(latest.verifiedBy, `verified this vendor's bank change${latest.verifiedAt ? ` on ${new Date(latest.verifiedAt).toISOString().slice(0, 10)}` : ""}`);
  }
  return [...reasons].map(([userId, why]) => ({ userId, reason: why.join("; ") }));
}
