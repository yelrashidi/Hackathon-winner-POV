"use client";

/**
 * The "Sort by" menu. Picking an option re-submits its form at once (a plain GET, so the choice
 * lives in the URL: shareable, survives refresh and paging). Without JavaScript, the form's own
 * Search / Filter button applies it. Options come from the server page (app/_lib/invoice-sort.ts).
 */
export function SortSelect({ value, options, className }: { value: string; options: { value: string; label: string }[]; className?: string }) {
  return (
    <select
      name="sort"
      defaultValue={value}
      aria-label="Sort by"
      className={className}
      onChange={(e) => {
        const form = e.currentTarget.form;
        if (!form) return;
        // A new order starts on page 1: drop a page number the form may carry.
        form.querySelector<HTMLInputElement>('input[name="page"]')?.remove();
        form.requestSubmit();
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
