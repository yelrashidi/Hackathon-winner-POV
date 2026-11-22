"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import type { ExtractionResult } from "../_lib/extraction-adapter";
import { ACCEPT_ATTRIBUTE, CHECK_THIS_BELOW, fileProblem } from "../_lib/upload-rules";
import { confirmUpload, type UploadForm } from "../actions";

type Option = { value: string; label: string };
type Status = "waiting" | "reading" | "ready" | "saved" | "rejected";
type Item = {
  id: number;
  file: File;
  url: string;
  status: Status;
  problem?: string;
  extraction?: ExtractionResult;
  savedAs?: string;
  form: UploadForm;
  errors: Record<string, string>;
};

const PROVINCES = ["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"];
const STATUS_LABEL: Record<Status, string> = {
  waiting: "Waiting",
  reading: "Reading…",
  ready: "Ready to check",
  saved: "Saved",
  rejected: "Not accepted",
};

function emptyForm(fileName: string): UploadForm {
  return {
    fileName,
    vendorName: "",
    invoiceNumber: "",
    invoiceDate: "",
    dueDate: "",
    currency: "",
    poNumber: "",
    shipToProvince: "",
    lines: [{ description: "", quantity: "", unitPrice: "", amount: "" }],
    taxes: [{ code: "", amount: "" }],
    subtotal: "",
    total: "",
    requesterId: "",
    departmentId: "",
    confidence: {},
  };
}

/** Prefill from extraction when it read the file; otherwise an empty form (manual entry). */
function formFrom(result: ExtractionResult, fileName: string, documentId?: string): UploadForm {
  const form = { ...emptyForm(fileName), documentId };
  if (result.status !== "ok") return form;
  const { lines, taxes, ...simple } = result.fields;
  return {
    ...form,
    ...simple,
    lines: lines?.length ? lines : form.lines,
    taxes: taxes?.length ? taxes : form.taxes,
    confidence: result.confidence as Record<string, number>,
  };
}

export function UploadWorkbench({
  people,
  departments,
  taxCodes,
}: {
  people: Option[];
  departments: Option[];
  taxCodes: Option[];
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [savedMessage, setSavedMessage] = useState<{ text: string; invoiceId: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [saving, startSaving] = useTransition();
  const nextId = useRef(1);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const urls = useRef<string[]>([]);

  // Free the in-browser copies of the files when leaving the page.
  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const update = (id: number, patch: Partial<Item>) =>
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));

  async function read(item: Item) {
    update(item.id, { status: "reading" });
    try {
      const body = new FormData();
      body.append("file", item.file);
      const response = await fetch("/checks/upload/extract", { method: "POST", body });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "The upload failed.");
      const result = data as ExtractionResult & { documentId?: string };
      update(item.id, { status: "ready", extraction: result, form: formFrom(result, item.file.name, result.documentId) });
      setActiveId((current) => current ?? item.id);
    } catch (error) {
      update(item.id, { status: "rejected", problem: error instanceof Error ? error.message : "The upload failed." });
    }
  }

  function addFiles(files: FileList | null) {
    if (!files?.length) return;
    const added: Item[] = [...files].map((file) => {
      const url = URL.createObjectURL(file);
      urls.current.push(url);
      const problem = fileProblem(file);
      return {
        id: nextId.current++,
        file,
        url,
        status: problem ? "rejected" : "waiting",
        problem: problem ?? undefined,
        form: emptyForm(file.name),
        errors: {},
      };
    });
    setItems((prev) => [...prev, ...added]);
    // One file at a time, in order: each read waits for the one before it.
    for (const item of added.filter((i) => i.status === "waiting")) {
      queue.current = queue.current.then(() => read(item));
    }
  }

  const active = items.find((i) => i.id === activeId && i.status === "ready") ?? null;

  function openNext(afterId: number) {
    const next = items.find((i) => i.id !== afterId && i.status === "ready");
    setActiveId(next ? next.id : null);
  }

  function remove(id: number) {
    setItems((prev) => prev.filter((i) => i.id !== id));
    if (activeId === id) openNext(id);
  }

  // When the open file is done, show the next one that has finished reading.
  const shown = active ?? items.find((i) => i.status === "ready") ?? null;

  return (
    <div className="space-y-6">
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors focus-within:ring-2 focus-within:ring-(--brim-link) ${
          dragging ? "border-(--brim-accent) bg-(--brim-accent)/10" : "border-slate-300 bg-white hover:border-(--brim-accent)"
        }`}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} className="h-8 w-8 text-(--brim-link)" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 16V4m0 0-4 4m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
        </svg>
        <span className="text-sm font-medium text-slate-900">Drop invoice files here, or click to choose</span>
        <span className="text-xs text-slate-500">PDF, PNG or JPG, up to 4 MB each</span>
        <input
          type="file"
          multiple
          accept={ACCEPT_ATTRIBUTE}
          className="sr-only"
          onChange={(e) => {
            addFiles(e.currentTarget.files);
            e.currentTarget.value = "";
          }}
        />
      </label>

      {savedMessage && (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800" role="status">
          {savedMessage.text}{" "}
          <Link href={`/checks/${savedMessage.invoiceId}`} className="font-semibold text-(--brim-link) underline">
            Open it in Checks →
          </Link>
        </p>
      )}

      {items.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {items.map((i) => (
            <li key={i.id}>
              <button
                type="button"
                disabled={i.status !== "ready"}
                onClick={() => setActiveId(i.id)}
                title={i.problem}
                className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-left text-xs transition-colors ${
                  shown?.id === i.id
                    ? "border-(--brim-accent) bg-(--brim-accent)/10"
                    : "border-slate-200 bg-white enabled:hover:border-slate-300"
                } disabled:cursor-default`}
              >
                <span className="max-w-48 truncate font-medium text-slate-900">{i.file.name}</span>
                <span
                  className={
                    i.status === "saved"
                      ? "text-emerald-700"
                      : i.status === "rejected"
                        ? "text-red-700"
                        : i.status === "ready"
                          ? "text-(--brim-link)"
                          : "text-slate-500"
                  }
                >
                  {i.status === "rejected" && i.problem ? `${STATUS_LABEL.rejected}: ${i.problem}` : STATUS_LABEL[i.status]}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {shown && (
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            <header className="border-b border-slate-200 px-5 py-3 text-sm font-semibold text-slate-900">{shown.file.name}</header>
            {shown.file.type === "application/pdf" ? (
              <iframe src={shown.url} title={shown.file.name} className="h-[75vh] w-full" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- local file preview, not an optimisable asset
              <img src={shown.url} alt={shown.file.name} className="max-h-[75vh] w-full object-contain" />
            )}
          </section>

          <InvoiceForm
            key={shown.id}
            item={shown}
            people={people}
            departments={departments}
            taxCodes={taxCodes}
            saving={saving}
            onChange={(patch) => update(shown.id, { form: { ...shown.form, ...patch } })}
            onConfirm={() => {
              setActiveId(shown.id);
              confirmItem(shown);
            }}
            onRemove={() => remove(shown.id)}
          />
        </div>
      )}
    </div>
  );

  function confirmItem(item: Item) {
    startSaving(async () => {
      const result = await confirmUpload(item.form);
      if (result.ok) {
        update(item.id, { status: "saved", errors: {}, savedAs: result.invoiceId });
        setSavedMessage({ text: result.message, invoiceId: result.invoiceId });
        openNext(item.id);
      } else {
        update(item.id, { errors: result.errors });
      }
    });
  }
}

function InvoiceForm({
  item,
  people,
  departments,
  taxCodes,
  saving,
  onChange,
  onConfirm,
  onRemove,
}: {
  item: Item;
  people: Option[];
  departments: Option[];
  taxCodes: Option[];
  saving: boolean;
  onChange: (patch: Partial<UploadForm>) => void;
  onConfirm: () => void;
  onRemove: () => void;
}) {
  const { form, errors } = item;
  const unread = item.extraction?.status !== "ok";
  const why =
    item.extraction?.status === "failed" || item.extraction?.status === "not_a_bill"
      ? item.extraction.reason
      : item.extraction?.status === "unavailable"
        ? "No extraction model is configured in this demo."
        : null;
  const unsure = (key: string) => (form.confidence[key] ?? 1) < CHECK_THIS_BELOW;

  const text = (key: keyof UploadForm, label: string, required = false, type = "text") => (
    <Field label={label} required={required} error={errors[key]} unsure={unsure(key)}>
      <input
        type={type}
        value={form[key] as string}
        onChange={(e) => onChange({ [key]: e.target.value })}
        className={inputClass(errors[key], unsure(key))}
      />
    </Field>
  );

  const select = (key: keyof UploadForm, label: string, options: Option[], required = false) => (
    <Field label={label} required={required} error={errors[key]} unsure={unsure(key)}>
      <select
        value={form[key] as string}
        onChange={(e) => onChange({ [key]: e.target.value })}
        className={inputClass(errors[key], unsure(key))}
      >
        <option value="">Choose…</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );

  const setLine = (i: number, patch: Partial<UploadForm["lines"][number]>) =>
    onChange({ lines: form.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const setTax = (i: number, patch: Partial<UploadForm["taxes"][number]>) =>
    onChange({ taxes: form.taxes.map((t, j) => (j === i ? { ...t, ...patch } : t)) });

  return (
    <section className="space-y-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      {unread && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          We couldn&apos;t read this file{why ? ` (${why})` : ""}. Type the details from the document.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {text("vendorName", "Vendor", true)}
        {text("invoiceNumber", "Invoice number", true)}
        {text("invoiceDate", "Invoice date", true, "date")}
        {text("dueDate", "Due date", false, "date")}
        {select("currency", "Currency", [
          { value: "CAD", label: "CAD" },
          { value: "USD", label: "USD" },
        ], true)}
        {text("poNumber", "PO number")}
        {select("shipToProvince", "Ship-to province", PROVINCES.map((p) => ({ value: p, label: p })))}
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-slate-700">Line items</p>
        <div className="space-y-2">
          {form.lines.map((l, i) => (
            <div key={i} className="grid grid-cols-[1fr_4.5rem_6.5rem_6.5rem_2rem] gap-2">
              <input aria-label="Description" placeholder="Description" value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} className={inputClass()} />
              <input aria-label="Quantity" placeholder="Qty" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} className={inputClass(errors[`lines.${i}.quantity`])} />
              <input aria-label="Unit price" placeholder="Unit price" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} className={inputClass(errors[`lines.${i}.unitPrice`])} />
              <input aria-label="Amount" placeholder="Amount" value={l.amount} onChange={(e) => setLine(i, { amount: e.target.value })} className={inputClass(errors[`lines.${i}.amount`])} />
              <RemoveRow label="Remove line" onClick={() => onChange({ lines: form.lines.filter((_, j) => j !== i) })} />
            </div>
          ))}
        </div>
        <AddRow label="+ Add line" onClick={() => onChange({ lines: [...form.lines, { description: "", quantity: "", unitPrice: "", amount: "" }] })} />
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-slate-700">Taxes</p>
        <div className="space-y-2">
          {form.taxes.map((t, i) => (
            <div key={i} className="grid grid-cols-[1fr_6.5rem_2rem] gap-2">
              <select aria-label="Tax code" value={t.code} onChange={(e) => setTax(i, { code: e.target.value })} className={inputClass(errors[`taxes.${i}.code`])}>
                <option value="">Choose…</option>
                {taxCodes.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
              <input aria-label="Tax amount" placeholder="Amount" value={t.amount} onChange={(e) => setTax(i, { amount: e.target.value })} className={inputClass(errors[`taxes.${i}.amount`])} />
              <RemoveRow label="Remove tax" onClick={() => onChange({ taxes: form.taxes.filter((_, j) => j !== i) })} />
            </div>
          ))}
        </div>
        <AddRow label="+ Add tax" onClick={() => onChange({ taxes: [...form.taxes, { code: "", amount: "" }] })} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {text("subtotal", "Subtotal")}
        {text("total", "Total", true)}
        {select("requesterId", "Requester", people, true)}
        {select("departmentId", "Department", departments, true)}
      </div>

      {errors.form && <p className="text-sm font-medium text-red-700">{errors.form}</p>}

      <div className="flex flex-wrap gap-3 border-t border-slate-100 pt-4">
        <button
          type="button"
          disabled={saving}
          onClick={onConfirm}
          className="rounded-lg bg-(--brim-accent) px-4 py-2 text-sm font-semibold text-(--brim-on-accent) hover:bg-(--brim-accent-hover) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--brim-link) focus-visible:ring-offset-2 disabled:opacity-60"
        >
          {saving ? "Saving…" : "Confirm invoice"}
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--brim-link)"
        >
          Remove
        </button>
      </div>
    </section>
  );
}

function Field({
  label,
  required,
  error,
  unsure,
  children,
}: {
  label: string;
  required: boolean;
  error?: string;
  unsure: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 flex items-center gap-2 font-medium text-slate-700">
        {label}
        {required && <span className="text-red-600">*</span>}
        {unsure && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-900">Check this</span>
        )}
      </span>
      {children}
      {error && <span className="mt-1 block text-xs text-red-700">{error}</span>}
    </label>
  );
}

function inputClass(error?: string, unsure = false): string {
  return `w-full rounded-lg border bg-white px-2.5 py-1.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-(--brim-link)/20 ${
    error ? "border-red-400" : unsure ? "border-amber-400" : "border-slate-200 focus:border-(--brim-link)"
  }`;
}

function AddRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="mt-2 text-sm font-medium text-(--brim-link) hover:underline">
      {label}
    </button>
  );
}

function RemoveRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"
    >
      ✕
    </button>
  );
}
