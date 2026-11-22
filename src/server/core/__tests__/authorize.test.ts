import { describe, expect, it } from "vitest";
import type { ActorRole } from "@/contracts/actor";
import { ACTIONS, authorize, can, Forbidden, type Action } from "../authorize";

/**
 * The role matrix from docs/architecture/roles-and-permissions.md, as a table. One row per action,
 * the roles that may do it. If the doc changes, this table and ACTIONS change together.
 * (Dashboard redesign, 2026-11-21: checks open to managers and the Finance Manager; the audit trail
 * is read by every dashboard role; export by the Auditor and the Controller/Admin.)
 */
const MATRIX: Record<Action, ActorRole[]> = {
  "invoice.submit": ["employee", "ap_clerk", "approver", "finance_manager", "controller_admin"],
  "invoice.review": ["ap_clerk", "approver", "finance_manager", "controller_admin"],
  "flag.resolve": ["ap_clerk", "approver", "finance_manager", "controller_admin"],
  "flag.override": ["ap_clerk", "approver", "finance_manager", "controller_admin"],
  "approval.decide": ["approver", "finance_manager", "controller_admin"],
  "payment.prepare": ["ap_clerk", "finance_manager", "controller_admin"],
  "payment.release": ["finance_manager", "controller_admin"],
  "vendor.view": ["ap_clerk", "finance_manager", "controller_admin", "auditor"],
  "vendor.onboard": ["ap_clerk", "finance_manager", "controller_admin"],
  "vendor.approve": ["finance_manager", "controller_admin"],
  "vendor.hold": ["ap_clerk", "finance_manager", "controller_admin"],
  "vendor.release_hold": ["finance_manager", "controller_admin"],
  "vendor.bank_change.request": ["ap_clerk", "finance_manager", "controller_admin"],
  "vendor.bank_change.verify": ["finance_manager", "controller_admin"],
  "admin.edit": ["controller_admin"],
  "audit.view": ["ap_clerk", "approver", "finance_manager", "controller_admin", "auditor"],
  "audit.export": ["auditor", "controller_admin"],
  "journal.export": ["finance_manager", "controller_admin"],
};
const ROLES: ActorRole[] = ["employee", "ap_clerk", "approver", "finance_manager", "controller_admin", "auditor", "system"];

describe("authorize(): the role matrix", () => {
  it("covers exactly the actions in the table", () => {
    expect(Object.keys(ACTIONS).sort()).toEqual(Object.keys(MATRIX).sort());
  });

  const cases = (Object.keys(MATRIX) as Action[]).flatMap((action) => ROLES.map((role) => ({ action, role, allowed: MATRIX[action].includes(role) })));
  it.each(cases)("$role → $action: $allowed", ({ action, role, allowed }) => {
    const actor = { userId: "U-test", role };
    expect(can(actor, action)).toBe(allowed);
    if (allowed) expect(authorize(actor, action)).toMatchObject({ action, actor: { userId: "U-test", role } });
    else expect(() => authorize(actor, action)).toThrow(Forbidden);
  });

  it("the auditor writes nothing (rule 6)", () => {
    const reads: Action[] = ["audit.view", "audit.export", "vendor.view"];
    const writes = (Object.keys(MATRIX) as Action[]).filter((a) => !reads.includes(a));
    for (const a of writes) expect(can({ userId: "U-a", role: "auditor" }, a)).toBe(false);
  });

  it("a refusal carries a reason the UI can show, and status 403", () => {
    try {
      authorize({ userId: "U-e", role: "employee" }, "payment.release");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Forbidden);
      expect((e as Forbidden).status).toBe(403);
      expect((e as Forbidden).reason).toBe("Your role (employee) cannot release payments.");
    }
  });

  it("a malformed actor (e.g. a role the browser invented) is refused, not trusted", () => {
    expect(() => authorize({ userId: "U-x", role: "superuser" as ActorRole }, "admin.edit")).toThrow(Forbidden);
    expect(can({ userId: "", role: "controller_admin" }, "admin.edit")).toBe(false);
  });
});
