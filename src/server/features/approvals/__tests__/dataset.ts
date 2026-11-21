import { readFileSync } from "node:fs";
import path from "node:path";
import type { ApprovalInput, ApprovalPlan } from "@/contracts/approvals";
import { applyDecision, checkDecision, PENDING_APPROVAL_STATUS, waitingOn, type InvoiceRef } from "../decide";
import { policiesFromCsv, type PolicyCsvRow } from "../policies-from-csv";
import type {
  ApprovalContext,
  DirectoryDepartment,
  DirectoryUser,
  DirectoryVendor,
  UserRole,
  UserStatus,
} from "../directory";

/**
 * Test-only loader: builds an ApprovalContext straight from the dataset CSVs, the same mapping
 * scripts/seed.ts will do into the DB. Override the folder with BRIM_DATA_DIR.
 */
export const DATA_DIR = process.env.BRIM_DATA_DIR ?? path.resolve(process.cwd(), "brim_ap_dataset/brim_ap_dataset/data");

/** Dataset as-of date (dataset README). */
export const DATASET_AS_OF = new Date("2026-11-02T00:00:00Z");

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => r.some((cell) => cell !== ""));
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

/** Read a dataset CSV and check it has `columns`, so each row is typed with exactly those columns. */
export function readCsv<K extends string>(name: string, columns: readonly K[]): Record<K, string>[] {
  const rows = parseCsv(readFileSync(path.join(DATA_DIR, name), "utf8"));
  for (const row of rows) {
    for (const c of columns) if (row[c] === undefined) throw new Error(`${name}: missing column "${c}"`);
  }
  return rows as Record<K, string>[];
}

const dollarsToCents = (s: string) => Math.round(Number(s || "0") * 100);

export function loadContext(asOf: Date = DATASET_AS_OF): ApprovalContext {
  const users = new Map<string, DirectoryUser>(
    readCsv("users.csv", ["user_id", "full_name", "role", "department_id", "manager_id", "approval_limit_cad", "status", "status_since", "delegate_user_id"]).map((u) => [
      u.user_id,
      {
        id: u.user_id,
        fullName: u.full_name,
        role: u.role as UserRole,
        departmentId: u.department_id,
        managerId: u.manager_id || null,
        approvalLimitCents: dollarsToCents(u.approval_limit_cad),
        status: u.status as UserStatus,
        statusSince: u.status_since || null,
        delegateId: u.delegate_user_id || null,
      },
    ]),
  );
  const departments = new Map<string, DirectoryDepartment>(
    readCsv("departments.csv", ["department_id", "name", "manager_user_id", "annual_budget_cad"]).map((d) => [
      d.department_id,
      {
        id: d.department_id,
        name: d.name,
        managerId: d.manager_user_id,
        annualBudgetCents: d.annual_budget_cad ? dollarsToCents(d.annual_budget_cad) : null,
      },
    ]),
  );
  const vendors = new Map<string, DirectoryVendor>(
    readCsv("vendors.csv", ["vendor_id", "legal_name", "category", "status", "requires_po", "onboarded_at"]).map((v) => [
      v.vendor_id,
      {
        id: v.vendor_id,
        legalName: v.legal_name,
        category: v.category,
        status: v.status,
        requiresPo: v.requires_po === "yes",
        onboardedAt: v.onboarded_at || null,
      },
    ]),
  );
  const policyRows: PolicyCsvRow[] = readCsv("approval_policies.csv", ["rule_id", "rule_type", "condition", "required", "notes"]);
  const policies = policiesFromCsv(policyRows);
  return { users, departments, vendors, policies, asOf };
}

/**
 * Approve every step with whoever the plan is waiting on, acknowledging every exception, all at
 * time `at`. Throws if anyone is refused: used to prove a plan can actually finish.
 */
export function approveAll(plan: ApprovalPlan, input: ApprovalInput, ctx: ApprovalContext, at: Date): ApprovalPlan {
  const ref: InvoiceRef = {
    invoiceId: input.invoiceId,
    invoiceVersion: input.invoiceVersion,
    status: PENDING_APPROVAL_STATUS,
    requesterId: input.requesterId,
    submittedBy: input.submittedBy ?? null,
    vendorId: input.vendorId,
  };
  let p = plan;
  for (let guard = 0; guard < 10; guard++) {
    const who = waitingOn(p, ref, ctx)?.assignee;
    if (!who) throw new Error(`${plan.invoiceId}: nobody to act`);
    const check = checkDecision(p, ref, who, { action: "approve", acknowledgedFlags: p.attention.map((a) => a.code) }, ctx);
    if (!check.ok) throw new Error(`${plan.invoiceId}: ${who} refused: ${check.code} ${check.reason}`);
    const r = applyDecision(p, check, at);
    p = { ...p, steps: r.steps };
    if (r.isLastStep) return p;
  }
  throw new Error(`${plan.invoiceId}: approval did not finish`);
}

/** Copy of ctx with one user changed — for leave / termination scenarios. */
export function withUser(ctx: ApprovalContext, id: string, patch: Partial<DirectoryUser>): ApprovalContext {
  const users = new Map(ctx.users);
  const u = users.get(id);
  if (!u) throw new Error(`no user ${id}`);
  users.set(id, { ...u, ...patch });
  return { ...ctx, users };
}

/** Historical invoices.csv rows as ApprovalInput (no flags: history has none). */
export function historicalInputs(): ApprovalInput[] {
  const lineDepts = new Map<string, string[]>();
  for (const l of readCsv("invoice_lines.csv", ["invoice_id", "department_id"])) lineDepts.set(l.invoice_id, [...(lineDepts.get(l.invoice_id) ?? []), l.department_id]);
  const poRequester = new Map(readCsv("purchase_orders.csv", ["po_id", "requester_user_id"]).map((p) => [p.po_id, p.requester_user_id]));
  return readCsv("invoices.csv", ["invoice_id", "vendor_id", "department_id", "requester_user_id", "po_id", "currency", "total", "fx_rate_to_cad", "total_cad"]).map((r) => ({
    invoiceId: r.invoice_id,
    invoiceVersion: 1,
    vendorId: r.vendor_id || null,
    vendorNameRaw: r.vendor_id,
    departmentId: r.department_id,
    requesterId: r.requester_user_id,
    poId: r.po_id || null,
    poRequesterId: (r.po_id && poRequester.get(r.po_id)) || null,
    currency: r.currency,
    totalCents: dollarsToCents(r.total),
    fxRateToCad: Number(r.fx_rate_to_cad),
    totalCadCents: dollarsToCents(r.total_cad),
    lineDepartmentIds: lineDepts.get(r.invoice_id) ?? [],
  }));
}
