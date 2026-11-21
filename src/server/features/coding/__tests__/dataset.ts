import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ValidationInputDraft } from "@/contracts/validation";
import type { VendorRef } from "@/server/features/validation";
import type { CodedLine, CodingContext } from "../context";
import { CodingIndex } from "../history";

/**
 * Test-only: builds a CodingContext from the dataset CSVs (the mapping scripts/seed.ts will do
 * into the DB) and reads the incoming batch that validation's owner extracted by hand.
 */
const DATA_DIR = process.env.BRIM_DATA_DIR ?? path.resolve(process.cwd(), "brim_ap_dataset/brim_ap_dataset/data");
const INCOMING_DIR = path.resolve(process.cwd(), "fixtures/validation/incoming");

type Row = Record<string, string>;

function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
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
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((x) => x !== "")) rows.push(row);
  }
  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

/** Rows typed with exactly `columns`; throws if the CSV lacks one. */
export function readCsv<K extends string>(file: string, columns: readonly K[]): Record<K, string>[] {
  const rows = parseCsv(readFileSync(path.join(DATA_DIR, file), "utf8"));
  for (const r of rows) for (const c of columns) if (r[c] === undefined) throw new Error(`${file}: missing column "${c}"`);
  return rows as Record<K, string>[];
}

export const cents = (s: string) => Math.round(Number(s || "0") * 100);

const invoiceRows = () =>
  readCsv("invoices.csv", ["invoice_id", "vendor_id", "vendor_invoice_number", "invoice_date", "received_date", "currency", "total", "subtotal", "department_id", "requester_user_id", "po_id", "status"]);
const lineRows = () =>
  readCsv("invoice_lines.csv", ["invoice_id", "line_no", "description", "quantity", "unit_price", "amount", "gl_account", "department_id", "line_type"]);

/** Every historical line, as coding history. */
export function historicalCodedLines(): CodedLine[] {
  const invoices = new Map(invoiceRows().map((r) => [r.invoice_id, r]));
  return lineRows().map((l) => {
    const inv = invoices.get(l.invoice_id);
    if (!inv) throw new Error(`line of unknown invoice ${l.invoice_id}`);
    return {
      invoiceId: l.invoice_id,
      vendorId: inv.vendor_id,
      invoiceNumber: inv.vendor_invoice_number || null,
      invoiceDate: inv.invoice_date,
      lineNo: Number(l.line_no),
      description: l.description,
      amountCents: cents(l.amount),
      glAccount: l.gl_account,
      departmentId: l.department_id,
      source: "historical",
      codedAt: null,
    };
  });
}

/** Reference data, with the history passed in (the whole history, or a prefix for the backtest). */
export function loadCodingContext(history: Iterable<CodedLine> = historicalCodedLines()): CodingContext {
  const glAccounts = new Map(
    readCsv("gl_accounts.csv", ["account_number", "name", "account_type", "notes"]).map((r) => [
      r.account_number,
      { number: r.account_number, name: r.name, type: r.account_type, notes: r.notes || null },
    ]),
  );
  const apControl = [...glAccounts.values()].find((a) => a.type === "liability" && /accounts payable/i.test(a.name));
  return {
    glAccounts,
    departments: new Map(readCsv("departments.csv", ["department_id", "name"]).map((r) => [r.department_id, { id: r.department_id, name: r.name }])),
    vendors: new Map(
      readCsv("vendors.csv", ["vendor_id", "legal_name", "category", "default_gl_account"]).map((r) => [
        r.vendor_id,
        { id: r.vendor_id, legalName: r.legal_name, category: r.category, defaultGlAccount: r.default_gl_account || null },
      ]),
    ),
    taxCodes: new Map(
      readCsv("tax_codes.csv", ["code", "rate", "applies_to", "recoverable", "gl_account"]).map((r) => [
        r.code,
        { code: r.code, rate: r.rate, appliesTo: r.applies_to, recoverable: r.recoverable, glAccount: r.gl_account || null },
      ]),
    ),
    purchaseOrders: readCsv("purchase_orders.csv", ["po_id", "vendor_id", "department_id", "status"]).map((r) => ({
      id: r.po_id,
      vendorId: r.vendor_id,
      departmentId: r.department_id || null,
      status: r.status,
    })),
    users: new Map(
      readCsv("users.csv", ["user_id", "full_name", "department_id"]).map((r) => [r.user_id, { id: r.user_id, fullName: r.full_name, departmentId: r.department_id }]),
    ),
    apControlAccount: apControl?.number ?? null,
    history: CodingIndex.from(history),
  };
}

export interface HistoricalInvoice {
  invoiceId: string;
  vendorId: string;
  invoiceDate: string;
  requesterId: string;
  departmentId: string;
  input: ValidationInputDraft;
  actual: CodedLine[];
}

/** The history as invoices to re-code, oldest first (the backtest replays them in order). */
export function historicalInvoices(): HistoricalInvoice[] {
  const lines = historicalCodedLines();
  const typeOf = new Map(lineRows().map((l) => [`${l.invoice_id}|${l.line_no}`, l]));
  const byInvoice = new Map<string, CodedLine[]>();
  for (const l of lines) byInvoice.set(l.invoiceId, [...(byInvoice.get(l.invoiceId) ?? []), l]);
  return invoiceRows()
    .map((r) => {
      const actual = (byInvoice.get(r.invoice_id) ?? []).sort((a, b) => a.lineNo - b.lineNo);
      return {
        invoiceId: r.invoice_id,
        vendorId: r.vendor_id,
        invoiceDate: r.invoice_date,
        requesterId: r.requester_user_id,
        departmentId: r.department_id,
        actual,
        input: {
          invoiceId: r.invoice_id,
          vendor: {},
          receivedDate: r.received_date || r.invoice_date,
          invoiceNumber: r.vendor_invoice_number,
          invoiceDate: r.invoice_date,
          currency: r.currency,
          subtotalCents: cents(r.subtotal),
          totalCents: cents(r.subtotal), // taxes are left out here: the backtest is about lines
          lines: actual.map((l) => {
            const raw = typeOf.get(`${l.invoiceId}|${l.lineNo}`)!;
            return {
              lineNo: l.lineNo,
              description: l.description,
              quantity: Number(raw.quantity),
              unitPriceCents: cents(raw.unit_price),
              amountCents: l.amountCents,
              lineType: raw.line_type === "goods" || raw.line_type === "services" ? raw.line_type : null,
            };
          }),
        } satisfies ValidationInputDraft,
      };
    })
    .sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate) || a.invoiceId.localeCompare(b.invoiceId));
}

/** Validation's VendorRef list, so tests resolve vendors with validation's public matchVendor. */
export function vendorRefs(): VendorRef[] {
  const counts = new Map<string, number>();
  for (const r of invoiceRows()) if (r.status !== "rejected") counts.set(r.vendor_id, (counts.get(r.vendor_id) ?? 0) + 1);
  return readCsv("vendors.csv", [
    "vendor_id", "legal_name", "category", "province_or_state", "country", "gst_hst_number", "qst_number",
    "payment_terms_days", "requires_po", "status", "ap_contact_email", "onboarded_at",
  ]).map((r) => ({
    id: r.vendor_id,
    legalName: r.legal_name,
    category: r.category,
    province: r.province_or_state || null,
    country: r.country || null,
    gstHstNumber: r.gst_hst_number || null,
    qstNumber: r.qst_number || null,
    paymentTermsDays: r.payment_terms_days ? Number(r.payment_terms_days) : null,
    requiresPo: r.requires_po === "yes",
    status: r.status,
    contactEmail: r.ap_contact_email || null,
    onboardedAt: r.onboarded_at || null,
    invoiceCount: counts.get(r.vendor_id) ?? 0,
  }));
}

/** The 56 incoming invoices as extracted by hand (fixtures/validation/incoming), with validation's expected flags. */
export function incomingInvoices(): { file: string; input: ValidationInputDraft; expectedCodes: string[] }[] {
  return readdirSync(INCOMING_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => {
      const fx = JSON.parse(readFileSync(path.join(INCOMING_DIR, file), "utf8")) as { input: ValidationInputDraft; expectedCodes: string[] | null };
      return { file, input: fx.input, expectedCodes: fx.expectedCodes ?? [] };
    });
}
