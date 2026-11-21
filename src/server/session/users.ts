// Server only: reads cookies / the filesystem. No `import "server-only"`: it throws outside Next, which breaks main's check:imports (CI).

// TEMP: reads the employee directory straight from the dataset CSV until the foundation's
// `users` table exists. Field names match DirectoryUser in features/approvals/directory.ts so
// the payment session can pass these users straight into its rules.

import { readFileSync } from "node:fs";
import path from "node:path";

export type UserRole =
  | "employee"
  | "ap_clerk"
  | "approver"
  | "finance_manager"
  | "controller_admin"
  | "auditor";

export type DirectoryUser = {
  id: string;
  fullName: string;
  title: string;
  role: UserRole;
  departmentId: string;
  managerId: string | null;
  approvalLimitCents: number;
  /** active | on_leave | terminated */
  status: string;
  statusSince: string | null;
  delegateId: string | null;
};

const USERS_CSV = path.join(process.cwd(), "brim_ap_dataset/brim_ap_dataset/data/users.csv");

let cached: DirectoryUser[] | null = null;

export function listUsers(): DirectoryUser[] {
  if (cached) return cached;
  const [header, ...rows] = parseCsv(readFileSync(USERS_CSV, "utf8"));
  if (!header) throw new Error("users.csv is empty");
  const at = (r: string[], name: string): string => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`users.csv has no column "${name}"`);
    return r[i] ?? "";
  };
  const users = rows.map((r) => ({
    id: at(r, "user_id"),
    fullName: at(r, "full_name"),
    title: at(r, "title"),
    role: at(r, "role") as UserRole,
    departmentId: at(r, "department_id"),
    managerId: at(r, "manager_id") || null,
    // approval_limit_cad is whole dollars in the dataset.
    approvalLimitCents: Number(at(r, "approval_limit_cad") || 0) * 100,
    status: at(r, "status"),
    statusSince: at(r, "status_since") || null,
    delegateId: at(r, "delegate_user_id") || null,
  }));
  cached = users;
  return users;
}

export function findUser(id: string): DirectoryUser | null {
  return listUsers().find((u) => u.id === id) ?? null;
}

/** Minimal CSV parser: commas, quoted fields with "" escapes, CRLF or LF line endings. */
export function parseCsv(text: string): string[][] {
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
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}
