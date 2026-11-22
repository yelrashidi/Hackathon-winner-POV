/** Normalisation and similarity for matching names, numbers and domains. */

/** "ST-4471" / "st 4471" / "ST4471" → "ST4471". */
export function normalizeInvoiceNumber(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** "995133220 RT 0001" → "995133220RT0001". */
export function normalizeTaxNumber(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Strips accents: "Montréal" → "Montreal". */
export function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * Light normalisation, used for an exact name match: lowercase, no accents, dots removed
 * ("S.E.N.C.R.L." → "sencrl", "Ltd." → "ltd"), other punctuation → space, "&" kept.
 * "Harlow & Stern LLP" and "Harlow and Stern LLP" stay DIFFERENT here on purpose.
 */
export function lightName(s: string): string {
  return stripAccents(s)
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/[^a-z0-9&]+/g, " ")
    .replace(/\s*&\s*/g, " & ")
    .trim()
    .replace(/\s+/g, " ");
}

const LEGAL_SUFFIXES = new Set([
  "inc", "incorporated", "ltd", "limited", "llc", "llp", "lp", "corp", "corporation",
  "co", "company", "plc", "sencrl", "senc", "srl", "ltee", "limitee", "the",
]);

/**
 * Core name, used for similarity: light name, "&" → "and", legal suffixes dropped.
 * "Harlow & Stern LLP" and "Harlow and Stern LLP" both → "harlow and stern".
 */
export function coreName(s: string): string {
  return lightName(s)
    .replace(/&/g, " and ")
    .split(/\s+/)
    .filter((w) => w && !LEGAL_SUFFIXES.has(w))
    .join(" ");
}

/** pg_trgm-style trigrams: each word padded "  word ". */
function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (const word of s.split(/\s+/).filter(Boolean)) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  }
  return out;
}

/** pg_trgm similarity: |shared trigrams| / |all trigrams|, 0..1. */
export function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 && tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

/** Levenshtein distance. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** "AR@PolarFreight.example" → "polarfreight.example"; null if not an email. */
export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1).trim().toLowerCase();
}

/** Digits only: "Acct 953 389 679" → "953389679". */
export function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}
