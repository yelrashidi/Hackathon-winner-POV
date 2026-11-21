import { ApprovalPolicy, ApproverRole, ReleaseRole } from "@/contracts/approvals";

/**
 * Turns the free-text rows of approval_policies.csv into structured `approval_policies` rows.
 * Called once by scripts/seed.ts; after that the Controller edits the structured rows, and the
 * router never reads policy text. Fails loudly on a row it does not understand, so a new policy
 * in a hidden dataset is a seed error, not a silently ignored rule.
 */

export interface PolicyCsvRow {
  rule_id: string;
  rule_type: string;
  condition: string;
  required: string;
  notes: string;
}

/** Default "brand-new vendor" window for P05. Admin-editable per policy after seeding. */
export const DEFAULT_NEW_VENDOR_DAYS = 90;

const dollarsToCents = (s: string) => Math.round(Number(s.replace(/,/g, "")) * 100);

export function policiesFromCsv(rows: readonly PolicyCsvRow[]): ApprovalPolicy[] {
  return rows.map((row, index) => ApprovalPolicy.parse(parseRow(row, index)));
}

function parseRow(row: PolicyCsvRow, index: number): ApprovalPolicy {
  const base = {
    id: row.rule_id,
    version: 1,
    active: true,
    description: [row.condition, row.notes].filter(Boolean).join(" — "),
  };
  const cond = row.condition.trim();
  const ruleType = row.rule_type.trim();
  let m: RegExpMatchArray | null;

  if (ruleType === "approval") {
    if ((m = cond.match(/^Invoice total (up to|over) \$([\d,]+(?:\.\d+)?)/i))) {
      const cadCents = dollarsToCents(m[2]);
      const roles = row.required.split(">").map((r) => ApproverRole.parse(r.trim()));
      return {
        ...base,
        ruleType,
        priority: index, // later tiers in the file sit above earlier ones
        conditions: m[1].toLowerCase() === "up to" ? { kind: "amount_up_to", cadCents } : { kind: "amount_over", cadCents },
        steps: { type: "chain", roles },
      };
    }
    if (/vendor status is pending_review|vendor is new/i.test(cond)) {
      return {
        ...base,
        ruleType,
        priority: 0,
        conditions: { kind: "vendor_new_or_pending", newVendorDays: DEFAULT_NEW_VENDOR_DAYS },
        steps: { type: "add_step", role: ApproverRole.parse(row.required.trim()) },
      };
    }
    if ((m = cond.match(/^Vendor category is (.+)$/i))) {
      return {
        ...base,
        ruleType,
        priority: 0,
        conditions: { kind: "vendor_category", category: m[1].trim() },
        steps: { type: "add_step", role: ApproverRole.parse(row.required.trim()) },
      };
    }
    if (/requester is the approver/i.test(cond)) {
      return { ...base, ruleType, priority: 0, conditions: { kind: "self_approval" }, steps: { type: "escalate_to_manager" } };
    }
    if (/approver is on leave/i.test(cond)) {
      return { ...base, ruleType, priority: 0, conditions: { kind: "approver_on_leave" }, steps: { type: "route_to_delegate" } };
    }
  }

  if (ruleType === "payment_release") {
    if ((m = cond.match(/^Payment (up to|over) \$([\d,]+(?:\.\d+)?)/i))) {
      const cadCents = dollarsToCents(m[2]);
      return {
        ...base,
        ruleType,
        priority: index,
        conditions: m[1].toLowerCase() === "up to" ? { kind: "amount_up_to", cadCents } : { kind: "amount_over", cadCents },
        steps: { type: "release_by", role: ReleaseRole.parse(row.required.trim()) },
      };
    }
    if (/^always$/i.test(cond) && /not the invoice approver/i.test(row.required)) {
      return { ...base, ruleType, priority: 0, conditions: { kind: "always" }, steps: { type: "release_not_approver" } };
    }
  }

  if (ruleType === "match") {
    if (/invoice references a PO/i.test(cond)) {
      // Validation (feature 4) computes the PO remaining balance and raises PO_OVER_BALANCE.
      return {
        ...base,
        ruleType,
        priority: 0,
        conditions: { kind: "open_flag", code: "PO_OVER_BALANCE" },
        steps: { type: "add_step", role: "finance_manager" },
      };
    }
    if (/requires a PO/i.test(cond)) {
      return { ...base, ruleType, priority: 0, conditions: { kind: "po_required_missing" }, steps: { type: "hold" } };
    }
  }

  throw new Error(
    `approval_policies.csv: cannot interpret ${row.rule_id} (${row.rule_type}: "${row.condition}" → "${row.required}"). ` +
      "Add a case to policiesFromCsv or enter it through the policy editor.",
  );
}
