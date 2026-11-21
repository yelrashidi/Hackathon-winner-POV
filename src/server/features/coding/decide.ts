import type { CodingConfidence, LineCoding } from "@/contracts/coding";
import type { Flag } from "@/contracts/flag";
import { codingFlag } from "./codes";
import { CODING_CONFIG as CFG } from "./config";
import type { CodedLine, CodingContext } from "./context";
import { reviewLine } from "./review";
import { clip } from "./text";

/**
 * A person accepts or changes each line's coding. Pure, so authorize() and the route handler
 * share it. The actor comes from the server session; the body is untrusted JSON.
 *
 *   codeLine(lines, lineNo, body, actor, ctx, now, invoice)   one line: accept or change
 *   acceptConfident(lines, actor, now)                        bulk-accept the high-confidence lines
 *   codingSubmitFlags(lines)                                  the submit guard: every line confirmed
 *   lineDepartments(lines)                                    for approvals' lineDepartmentIds
 *   toCodedLines(lines, invoice)                              feeds confirmed lines back to the history
 */

/** Permission matrix: "Ingest inbox, review extraction, code, resolve flags" — AP Clerk and Controller. */
export const CODING_ROLES: ReadonlySet<string> = new Set(["ap_clerk", "controller_admin"]);

export interface CodingActor {
  id: string;
  role: string;
  status: string;
}

export interface InvoiceCodingRef {
  invoiceId: string;
  vendorId: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  /** The requesting department (invoices.department_id), if set. */
  departmentId: string | null;
  currency: string | null;
}

export type CodingDeniedCode =
  | "INVALID_REQUEST"
  | "USER_INACTIVE"
  | "ROLE_CANNOT_CODE"
  | "LINE_NOT_FOUND"
  | "ACCOUNT_NOT_CODABLE"
  | "UNKNOWN_DEPARTMENT"
  | "NOTE_REQUIRED";

export type CodingDenied = { ok: false; status: 400 | 403 | 404; code: CodingDeniedCode; reason: string };

const deny = (status: 400 | 403 | 404, code: CodingDeniedCode, reason: string): CodingDenied => ({ ok: false, status, code, reason });

function checkActor(actor: CodingActor): CodingDenied | null {
  if (actor.status !== "active") return deny(403, "USER_INACTIVE", `Your account is ${actor.status.replace(/_/g, " ")}, so you cannot code invoices.`);
  if (!CODING_ROLES.has(actor.role)) return deny(403, "ROLE_CANNOT_CODE", `Your role (${actor.role}) cannot code invoices; AP clerks and the controller do.`);
  return null;
}

/** Accept or change one line's account and department. */
export function codeLine(
  lines: readonly LineCoding[],
  lineNo: number,
  rawBody: unknown,
  actor: CodingActor,
  ctx: CodingContext,
  now: Date,
  invoice: InvoiceCodingRef,
): { ok: true; lines: LineCoding[]; line: LineCoding; flags: Flag[] } | CodingDenied {
  const body = (rawBody ?? {}) as Record<string, unknown>;
  const { glAccount, departmentId, note } = body;
  if (typeof glAccount !== "string" || typeof departmentId !== "string") return deny(400, "INVALID_REQUEST", "glAccount and departmentId must be text.");
  if (note !== undefined && note !== null && typeof note !== "string") return deny(400, "INVALID_REQUEST", "note must be text.");
  if (typeof note === "string" && note.length > CFG.maxNoteLength) return deny(400, "INVALID_REQUEST", `note is longer than ${CFG.maxNoteLength} characters.`);

  const actorProblem = checkActor(actor);
  if (actorProblem) return actorProblem;
  const current = lines.find((l) => l.lineNo === lineNo);
  if (!current) return deny(404, "LINE_NOT_FOUND", `This invoice has no line ${lineNo}.`);

  const account = ctx.glAccounts.get(glAccount.trim());
  if (!account) return deny(400, "ACCOUNT_NOT_CODABLE", `${glAccount} is not in the chart of accounts.`);
  if (account.type !== "expense") {
    return deny(400, "ACCOUNT_NOT_CODABLE", `${account.number} ${account.name} is a ${account.type} account; invoice lines are coded to expense accounts (tax and payables are posted automatically).`);
  }
  const dept = ctx.departments.get(departmentId.trim());
  if (!dept) return deny(400, "UNKNOWN_DEPARTMENT", `${departmentId} is not a department.`);

  const accountChanged = account.number !== current.account.value;
  const deptChanged = dept.id !== current.department.value;
  const text = typeof note === "string" ? note.trim() : "";
  const overridesConfident = (accountChanged && current.account.confidence === "high") || (deptChanged && current.department.confidence === "high");
  if (overridesConfident && !text) {
    return deny(400, "NOTE_REQUIRED", `The suggestion was high confidence (${accountChanged ? current.account.reason : current.department.reason}); say why you are changing it.`);
  }

  const line: LineCoding = {
    ...current,
    glAccount: account.number,
    departmentId: dept.id,
    source: accountChanged || deptChanged ? "changed" : "accepted",
    codedBy: actor.id,
    codedAt: now.toISOString(),
    note: text || null,
  };
  const flags: Flag[] = [...reviewLine(line, ctx, invoice.currency)];
  const history = invoice.vendorId ? ctx.history.vendorLines(invoice.vendorId) : [];
  if (accountChanged && history.length >= CFG.unusualMinHistory && !history.some((h) => h.glAccount === account.number)) {
    const usual = [...new Set(history.slice(0, CFG.window).map((h) => h.glAccount))].join(", ");
    const vendorName = ctx.vendors.get(invoice.vendorId!)?.legalName ?? invoice.vendorId;
    flags.push(
      codingFlag(
        "CODING_UNUSUAL_ACCOUNT",
        `Line ${lineNo} "${clip(line.description)}" was coded to ${account.number} ${account.name}, which ${vendorName} has never been coded to (its last ${Math.min(history.length, CFG.window)} lines went to ${usual}).`,
        { field: "lines", lineNo, glAccount: account.number, usualAccounts: usual },
      ),
    );
  }
  if (invoice.departmentId && dept.id !== invoice.departmentId) {
    flags.push(
      codingFlag(
        "CODING_DEPARTMENT_DIFFERS",
        `Line ${lineNo} is charged to ${dept.name} (${dept.id}), but the invoice was requested by ${ctx.departments.get(invoice.departmentId)?.name ?? invoice.departmentId}; ${dept.name}'s manager does not approve it.`,
        { field: "lines", lineNo, departmentId: dept.id, invoiceDepartmentId: invoice.departmentId },
      ),
    );
  }
  return { ok: true, lines: lines.map((l) => (l.lineNo === lineNo ? line : l)), line, flags };
}

const RANK: Record<CodingConfidence, number> = { none: 0, low: 1, medium: 2, high: 3 };

/** Bulk-accept every still-suggested line whose account AND department are at least `minimum` confident. */
export function acceptConfident(
  lines: readonly LineCoding[],
  actor: CodingActor,
  now: Date,
  minimum: "high" | "medium" = "high",
): { ok: true; lines: LineCoding[]; accepted: number[] } | CodingDenied {
  const actorProblem = checkActor(actor);
  if (actorProblem) return actorProblem;
  const accepted: number[] = [];
  const out = lines.map((l) => {
    const sure = l.source === "suggested" && l.glAccount && l.departmentId && RANK[l.account.confidence] >= RANK[minimum] && RANK[l.department.confidence] >= RANK[minimum];
    if (!sure) return l;
    accepted.push(l.lineNo);
    return { ...l, source: "accepted" as const, codedBy: actor.id, codedAt: now.toISOString(), note: null };
  });
  return { ok: true, lines: out, accepted };
}

/** The submit guard: block until a person has accepted or changed every line. */
export function codingSubmitFlags(lines: readonly LineCoding[]): Flag[] {
  if (lines.length === 0) return [codingFlag("CODING_NOT_CONFIRMED", "The invoice has no coded lines; enter and code its lines before submitting it.", { field: "lines" })];
  const open = lines.filter((l) => l.source === "suggested" || !l.glAccount || !l.departmentId);
  if (open.length === 0) return [];
  return [
    codingFlag(
      "CODING_NOT_CONFIRMED",
      `${open.length} of ${lines.length} line${lines.length === 1 ? "" : "s"} still need a person to accept or change the coding (line${open.length === 1 ? "" : "s"} ${open.map((l) => l.lineNo).join(", ")}).`,
      { field: "lines", lineNos: open.map((l) => l.lineNo) },
    ),
  ];
}

/** Every department the lines are charged to: approvals' `lineDepartmentIds`. */
export function lineDepartments(lines: readonly LineCoding[]): string[] {
  return [...new Set(lines.map((l) => l.departmentId).filter((d): d is string => d !== null))];
}

/**
 * Confirmed lines as history, for `CodingIndex.add` once the invoice is approved: a person's
 * correction becomes evidence for the very next invoice from that vendor.
 */
export function toCodedLines(lines: readonly LineCoding[], invoice: InvoiceCodingRef): CodedLine[] {
  if (!invoice.vendorId || !invoice.invoiceDate) return [];
  return lines
    .filter((l): l is LineCoding & { glAccount: string; departmentId: string; source: "accepted" | "changed" } => l.source !== "suggested" && l.glAccount !== null && l.departmentId !== null)
    .map((l) => ({
      invoiceId: invoice.invoiceId,
      vendorId: invoice.vendorId!,
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate!,
      lineNo: l.lineNo,
      description: l.description,
      amountCents: l.amountCents,
      glAccount: l.glAccount,
      departmentId: l.departmentId,
      source: l.source,
      codedAt: l.codedAt,
    }));
}
