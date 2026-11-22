// Shared form-field classes. Kept in a plain module (not a "use client" file): a server page that
// imports a value from a client file gets a client reference, not the string, so `w-64 ${inputClass}`
// would render unstyled.
export const inputClass =
  "rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 placeholder:text-slate-400 focus:border-(--brim-link) focus:outline-none focus:ring-2 focus:ring-(--brim-link)/20";
export const fieldClass =
  "w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-(--brim-link) focus:outline-none focus:ring-2 focus:ring-(--brim-link)/20";
