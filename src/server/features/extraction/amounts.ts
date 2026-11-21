/**
 * Printed amounts → integer cents, without floats. Handles both conventions:
 *   "$3,000.30"  "-$1,042.76"  "(185.71)"  "2 260,00 $"  "1.234,56"  "1'234.50"  "USD 12"
 * The last "." or "," followed by 1–2 digits at the end is the decimal mark; any other "." or ","
 * must be a thousands mark (groups of three), otherwise the value is rejected as unreadable.
 * TODO(foundation): move to src/server/core/money.ts once it exists.
 */
const MINUS = /[-−–]/;

export function parseAmountToCents(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  let s = raw.replace(/[  ]/g, " ").trim();
  if (s === "") return null;

  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1).trim(); }
  if (/\bCR$/i.test(s)) { negative = true; s = s.replace(/\bCR$/i, ""); }
  if (MINUS.test(s)) { negative = true; s = s.replace(new RegExp(MINUS, "g"), ""); }

  // Drop currency symbols/codes, spaces and apostrophe thousands marks.
  s = s.replace(/[A-Za-z$€£¢\s'’]/g, "");
  if (!/^[\d.,]*\d[\d.,]*$/.test(s)) return null;

  const decimal = s.match(/[.,](\d{1,2})$/);
  const wholePart = decimal ? s.slice(0, s.length - decimal[0].length) : s;
  if (/[.,]/.test(wholePart) && !/^\d{1,3}([.,]\d{3})+$/.test(wholePart)) return null;
  const whole = wholePart.replace(/[.,]/g, "") || "0";
  if (whole.length > 11) return null; // a billion-dollar line is a misread, not an invoice
  const cents = Number(whole) * 100 + Number((decimal?.[1] ?? "").padEnd(2, "0"));
  return negative && cents !== 0 ? -cents : cents;
}

/** "Net 30" → 30, "30 jours net" → 30, "Due on receipt" / "Payable à réception" → 0. */
export function parsePaymentTermsDays(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const s = raw.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const n = s.match(/net\s*(\d{1,3})|(\d{1,3})\s*(?:days|jours|j\b)/);
  if (n) return Number(n[1] ?? n[2]);
  if (/receipt|reception|immediate/.test(s)) return 0;
  return null;
}
