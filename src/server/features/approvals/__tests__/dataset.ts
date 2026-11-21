import { readFileSync } from "node:fs";
import path from "node:path";
import type { ApprovalInput } from "@/contracts/approvals";
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
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

export const readCsv = (name: string) => parseCsv(readFileSync(path.join(DATA_DIR, name), "utf8"));

const dollarsToCents = (s: string) => Math.round(Number(s || "0") * 100);

export function loadContext(asOf: Date = DATASET_AS_OF): ApprovalContext {
  const users = new Map<string, DirectoryUser>(
    readCsv("users.csv").map((u) => [
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
    readCsv("departments.csv").map((d) => [
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
    readCsv("vendors.csv").map((v) => [
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
  const policies = policiesFromCsv(readCsv("approval_policies.csv") as unknown as PolicyCsvRow[]);
  return { users, departments, vendors, policies, asOf };
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
  for (const l of readCsv("invoice_lines.csv")) lineDepts.set(l.invoice_id, [...(lineDepts.get(l.invoice_id) ?? []), l.department_id]);
  const poRequester = new Map(readCsv("purchase_orders.csv").map((p) => [p.po_id, p.requester_user_id]));
  return readCsv("invoices.csv").map((r) => ({
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
