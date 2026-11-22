"use client";

import { useState, useTransition, type ReactNode } from "react";
import { parseMoneyToCents } from "../../payments/_lib/format";
import { fieldClass } from "../../_lib/styles";
import { manualEntryAction } from "../actions";

type Option = { value: string; label: string };
type Person = Option & { group: string };
type Line = { description: string; quantity: string; unitPrice: string; amount: string; lineType: "" | "goods" | "services" };
type Tax = { code: string; amount: string };

const PROVINCES = ["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"];
const emptyLine = (): Line => ({ description: "", quantity: "1", unitPrice: "", amount: "", lineType: "" });

/**
 * Typing in a bill extraction could not read. Amounts are parsed to integer cents here only to give
 * instant feedback; the server parses the submitted fields again with the contract (ManualFields)
 * and refuses anything invalid, so this form is a convenience, not the check.
 */
export function ManualEntryForm({ invoiceId, people, departments, taxCodes }: { invoiceId: string; people: Person[]; departments: Option[]; taxCodes: (Option & { ratePct: number })[] }) {
  const [f, setF] = useState({
    documentType: "invoice" as "invoice" | "credit_note",
    vendorNameRaw: "",
    invoiceNumber: "",
    invoiceDate: "",
    dueDate: "",
    currency: "CAD",
    poNumber: "",
    shipToProvince: "",
    subtotal: "",
    total: "",
    requesterId: "",
    departmentId: "",
  });
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [taxes, setTaxes] = useState<Tax[]>([{ code: "", amount: "" }]);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, start] = useTransition();
  const set = (patch: Partial<typeof f>) => setF((prev) => ({ ...prev, ...patch }));

  function submit() {
    const problems: string[] = [];
    const money = (label: string, v: string, required = false) => {
      if (!v.trim()) {
        if (required) problems.push(`${label} is required.`);
        return null;
      }
      const c = parseMoneyToCents(v);
      if (c === null) problems.push(`${label}: “${v}” is not an amount.`);
      return c;
    };
    const total = money("Total", f.total, true);
    const subtotal = money("Subtotal", f.subtotal);
    const parsedLines = lines
      .filter((l) => l.description.trim() || l.amount.trim())
      .map((l, i) => {
        const quantity = Number(l.quantity || "1");
        if (!Number.isFinite(quantity)) problems.push(`Line ${i + 1}: quantity is not a number.`);
        const amountCents = money(`Line ${i + 1} amount`, l.amount, true) ?? 0;
        // No division on money: a blank unit price is only accepted for a quantity of 1.
        if (!l.unitPrice.trim() && quantity !== 1) problems.push(`Line ${i + 1}: enter the unit price (quantity is ${l.quantity}).`);
        const unitPriceCents = l.unitPrice.trim() ? (money(`Line ${i + 1} unit price`, l.unitPrice) ?? amountCents) : amountCents;
        return { description: l.description.trim() || `Line ${i + 1}`, quantity, unitPriceCents, amountCents, lineType: l.lineType || null };
      });
    if (parsedLines.length === 0) problems.push("Enter at least one line.");
    const parsedTaxes = taxes
      .filter((t) => t.code || t.amount.trim())
      .map((t, i) => {
        const code = taxCodes.find((c) => c.value === t.code);
        if (!code) problems.push(`Tax ${i + 1}: choose a tax code.`);
        return { code: t.code, label: code?.label ?? t.code, ratePct: code?.ratePct ?? null, amountCents: money(`Tax ${i + 1}`, t.amount, true) ?? 0 };
      });
    if (!f.vendorNameRaw.trim()) problems.push("Vendor is required.");
    if (!f.invoiceNumber.trim()) problems.push("Invoice number is required.");
    if (!f.invoiceDate) problems.push("Invoice date is required.");
    setErrors(problems);
    if (problems.length) return;

    start(async () => {
      const result = await manualEntryAction(invoiceId, {
        documentType: f.documentType,
        vendorNameRaw: f.vendorNameRaw,
        invoiceNumber: f.invoiceNumber,
        invoiceDate: f.invoiceDate,
        dueDate: f.dueDate || null,
        currency: f.currency as "CAD" | "USD",
        poNumber: f.poNumber.trim() || null,
        shipToProvince: f.shipToProvince || null,
        subtotalCents: subtotal,
        totalCents: total!,
        requesterId: f.requesterId || null,
        departmentId: f.departmentId || null,
        lines: parsedLines,
        taxes: parsedTaxes,
      });
      if (result && !result.ok) setErrors(result.errors);
    });
  }

  return (
    <section className="space-y-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Vendor (as written on the invoice)" required>
          <input value={f.vendorNameRaw} onChange={(e) => set({ vendorNameRaw: e.target.value })} className={fieldClass} />
        </Field>
        <Field label="Document">
          <select value={f.documentType} onChange={(e) => set({ documentType: e.target.value as "invoice" | "credit_note" })} className={fieldClass}>
            <option value="invoice">Invoice</option>
            <option value="credit_note">Credit note</option>
          </select>
        </Field>
        <Field label="Invoice number" required>
          <input value={f.invoiceNumber} onChange={(e) => set({ invoiceNumber: e.target.value })} className={fieldClass} />
        </Field>
        <Field label="Currency" required>
          <select value={f.currency} onChange={(e) => set({ currency: e.target.value })} className={fieldClass}>
            <option value="CAD">CAD</option>
            <option value="USD">USD</option>
          </select>
        </Field>
        <Field label="Invoice date" required>
          <input type="date" value={f.invoiceDate} onChange={(e) => set({ invoiceDate: e.target.value })} className={fieldClass} />
        </Field>
        <Field label="Due date">
          <input type="date" value={f.dueDate} onChange={(e) => set({ dueDate: e.target.value })} className={fieldClass} />
        </Field>
        <Field label="PO number">
          <input value={f.poNumber} onChange={(e) => set({ poNumber: e.target.value })} className={fieldClass} />
        </Field>
        <Field label="Ship-to province">
          <select value={f.shipToProvince} onChange={(e) => set({ shipToProvince: e.target.value })} className={fieldClass}>
            <option value="">—</option>
            {PROVINCES.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </Field>
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-slate-700">Line items</p>
        <div className="space-y-2">
          {lines.map((l, i) => (
            <div key={i} className="grid grid-cols-[1fr_3.5rem_5.5rem_5.5rem_6rem_1.5rem] gap-2">
              <input aria-label="Description" placeholder="Description" value={l.description} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} className={fieldClass} />
              <input aria-label="Quantity" placeholder="Qty" value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} className={fieldClass} />
              <input aria-label="Unit price" placeholder="Unit" value={l.unitPrice} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, unitPrice: e.target.value } : x)))} className={fieldClass} />
              <input aria-label="Amount" placeholder="Amount" value={l.amount} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} className={fieldClass} />
              <select aria-label="Type" value={l.lineType} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, lineType: e.target.value as Line["lineType"] } : x)))} className={fieldClass}>
                <option value="">Type…</option>
                <option value="goods">Goods</option>
                <option value="services">Services</option>
              </select>
              <button type="button" aria-label="Remove line" onClick={() => setLines(lines.filter((_, j) => j !== i))} className="text-slate-400 hover:text-slate-700">
                ✕
              </button>
            </div>
          ))}
        </div>
        <button type="button" onClick={() => setLines([...lines, emptyLine()])} className="mt-2 text-sm font-medium text-(--brim-link) hover:underline">
          + Add line
        </button>
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-slate-700">Taxes</p>
        <div className="space-y-2">
          {taxes.map((t, i) => (
            <div key={i} className="grid grid-cols-[1fr_6.5rem_1.5rem] gap-2">
              <select aria-label="Tax code" value={t.code} onChange={(e) => setTaxes(taxes.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)))} className={fieldClass}>
                <option value="">Choose…</option>
                {taxCodes.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
              <input aria-label="Tax amount" placeholder="Amount" value={t.amount} onChange={(e) => setTaxes(taxes.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} className={fieldClass} />
              <button type="button" aria-label="Remove tax" onClick={() => setTaxes(taxes.filter((_, j) => j !== i))} className="text-slate-400 hover:text-slate-700">
                ✕
              </button>
            </div>
          ))}
        </div>
        <button type="button" onClick={() => setTaxes([...taxes, { code: "", amount: "" }])} className="mt-2 text-sm font-medium text-(--brim-link) hover:underline">
          + Add tax
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Subtotal">
          <input value={f.subtotal} onChange={(e) => set({ subtotal: e.target.value })} className={fieldClass} />
        </Field>
        <Field label="Total" required>
          <input value={f.total} onChange={(e) => set({ total: e.target.value })} className={fieldClass} />
        </Field>
        <Field label="Requester (who asked for it)">
          <select value={f.requesterId} onChange={(e) => set({ requesterId: e.target.value })} className={fieldClass}>
            <option value="">Choose…</option>
            {[...new Set(people.map((p) => p.group))].map((group) => (
              <optgroup key={group} label={group}>
                {people
                  .filter((p) => p.group === group)
                  .map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </Field>
        <Field label="Department">
          <select value={f.departmentId} onChange={(e) => set({ departmentId: e.target.value })} className={fieldClass}>
            <option value="">Let coding suggest it</option>
            {departments.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {errors.length > 0 && (
        <ul role="alert" className="rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {errors.map((e) => (
            <li key={e}>✗ {e}</li>
          ))}
        </ul>
      )}
      <div className="border-t border-slate-100 pt-4">
        <button
          type="button"
          disabled={saving}
          onClick={submit}
          className="rounded-lg bg-(--brim-accent) px-4 py-2 text-sm font-semibold text-(--brim-on-accent) hover:bg-(--brim-accent-hover) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--brim-link) focus-visible:ring-offset-2 disabled:opacity-60"
        >
          {saving ? "Saving and checking…" : "Save and run the checks"}
        </button>
      </div>
    </section>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 flex items-center gap-1 text-xs font-medium text-slate-600">
        {label}
        {required && <span className="text-red-600">*</span>}
      </span>
      {children}
    </label>
  );
}
