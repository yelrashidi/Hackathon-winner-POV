import { describe, expect, it } from "vitest";
import type { ActorRole } from "@/contracts/actor";
import { ACTIONS, authorize, can, Forbidden, type Action } from "../authorize";

/**
 * The role matrix from docs/architecture/roles-and-permissions.md, as a table. One row per action,
 * the roles that may do it. If the doc changes, this table and ACTIONS change together.
 * (Audit view/export is auditor-only by the team's 2026-11-21 decision; the doc also lists the
 * Controller for "view full audit log" — see docs/architecture/8-audit.md.)
 */
const MATRIX: Record<Action, ActorRole[]> = {
  "invoice.submit": ["employee", "ap_clerk", "approver", "finance_manager", "controller_admin"],
  "invoice.review": ["ap_clerk", "controller_admin"],
  "flag.resolve": ["ap_clerk", "controller_admin"],
  "flag.override": ["ap_clerk", "controller_admin"],
  "approval.decide": ["approver", "finance_manager", "controller_admin"],
  "payment.prepare": ["ap_clerk", "finance_manager", "controller_admin"],
  "payment.release": ["finance_manager", "controller_admin"],
  "vendor.bank_change.request": ["ap_clerk", "finance_manager", "controller_admin"],
  "vendor.bank_change.verify": ["finance_manager", "controller_admin"],
  "admin.edit": ["controller_admin"],
  "audit.view": ["auditor"],
  "audit.export": ["auditor"],
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
    const writes = (Object.keys(MATRIX) as Action[]).filter((a) => !a.startsWith("audit."));
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
