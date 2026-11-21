/**
 * Turns a line description into comparable words, so "Pallets (48x40), qty 539" and
 * "Pallets (48x40), qty 213" are the same kind of line, and "Loyer de base - Montréal" is
 * comparable to "Base rent - Montreal".
 *
 *   lowercase, accents off → numbers, sizes and codes dropped → stopwords (EN + FR) dropped →
 *   French words mapped to English → simple plural folding ("pallets" → "pallet", "supplies" → "supply")
 *
 * Deliberately simple and deterministic: every step can be explained, and the description is
 * only ever data (text inside an invoice is never an instruction).
 */

const STOPWORDS = new Set([
  // English
  "a", "an", "and", "at", "by", "for", "from", "in", "of", "on", "per", "the", "to", "with", "qty", "x", "no",
  // French
  "au", "aux", "d", "de", "des", "du", "en", "et", "l", "la", "le", "les", "par", "pour", "sur", "un", "une",
  // words that describe the document, not the purchase
  "credit", "avoir", "invoice", "facture", "note", "ref", "re",
]);

/** French (accent-free) → the English word the history uses. Unlisted words pass through. */
const FRENCH: Readonly<Record<string, string>> = {
  loyer: "rent",
  frais: "cost",
  exploitation: "operating",
  entretien: "maintenance",
  reparation: "repair",
  reparations: "repair",
  nettoyage: "cleaning",
  menage: "cleaning",
  conciergerie: "janitorial",
  honoraires: "fee",
  juridique: "legal",
  juridiques: "legal",
  avocat: "legal",
  expedition: "shipment",
  envoi: "shipment",
  livraison: "delivery",
  transport: "freight",
  carburant: "fuel",
  essence: "fuel",
  assurance: "insurance",
  prime: "premium",
  electricite: "energy",
  energie: "energy",
  cellulaire: "mobile",
  forfait: "plan",
  formation: "training",
  deplacement: "travel",
  voyage: "travel",
  billet: "airfare",
  avion: "airfare",
  hebergement: "hotel",
  repas: "meal",
  traiteur: "catering",
  fourniture: "supply",
  fournitures: "supply",
  bureau: "office",
  mobilier: "furniture",
  chaise: "chair",
  chaises: "chair",
  logiciel: "software",
  abonnement: "subscription",
  publicite: "advertising",
  impression: "printing",
  enseigne: "signage",
  affiche: "signage",
  conseil: "consulting",
  comptabilite: "accounting",
  verification: "audit",
  recrutement: "recruiting",
  securite: "safety",
  bottes: "boot",
  gants: "glove",
  palette: "pallet",
  palettes: "pallet",
  emballage: "packaging",
  entreposage: "warehousing",
  salle: "venue",
};

/** "Montréal" → "montreal". */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function singular(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) return w.slice(0, -1);
  return w;
}

/** Distinct comparable words of a description, in order. */
export function tokenize(description: string): string[] {
  const out: string[] = [];
  for (const raw of fold(description).split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || /\d/.test(raw) || STOPWORDS.has(raw)) continue;
    const word = singular(FRENCH[raw] ?? raw);
    if (!STOPWORDS.has(word) && !out.includes(word)) out.push(word);
  }
  return out;
}

/**
 * Weighted Jaccard: shared words / all words, each word weighted by how rare it is (idf), so
 * "racking" counts for more than "service". 0 = nothing in common, 1 = the same words.
 */
export function similarity(a: readonly string[], b: readonly string[], idf: (token: string) => number): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let shared = 0;
  let all = 0;
  for (const t of new Set([...a, ...b])) {
    const w = idf(t);
    all += w;
    if (setB.has(t) && a.includes(t)) shared += w;
  }
  return all === 0 ? 0 : shared / all;
}

/** "GR26-2262" / "gr26 2262" → "GR262262": how a credit note finds the invoice it reverses. */
export function normalizeDocNumber(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** "$1,234.56" for CAD (or unknown currency), "USD 1,234.56" otherwise. */
export function formatMoney(cents: number, currency: string | null): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const amount = `${Math.floor(abs / 100).toLocaleString("en-CA")}.${String(abs % 100).padStart(2, "0")}`;
  return currency && currency.toUpperCase() !== "CAD" ? `${sign}${currency.toUpperCase()} ${amount}` : `${sign}$${amount}`;
}

/** Text from a document is data: keep it short and on one line in messages. */
export function clip(text: string, max = 60): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
