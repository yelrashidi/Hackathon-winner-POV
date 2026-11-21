import type {
  AccountBasis,
  AccountSuggestion,
  CodingAlternative,
  CodingConfidence,
  CodingResult,
  DepartmentBasis,
  DepartmentSuggestion,
  LineCoding,
} from "@/contracts/coding";
import type { Flag } from "@/contracts/flag";
import { ValidationInput, type ValidationInputDraft, type ValidationLine } from "@/contracts/validation";
import { codingFlag } from "./codes";
import { CODING_CONFIG as CFG } from "./config";
import type { CodingContext, CodingVendorRef } from "./context";
import type { IndexedLine } from "./history";
import { buildJournal } from "./journal";
import { reviewLine } from "./review";
import { clip, formatMoney, normalizeDocNumber, similarity, tokenize } from "./text";

/**
 * Feature 3 — suggests a GL account and a department for every line of an extracted invoice.
 * Pure: (invoice, vendor id, reference data + coding history) → CodingResult. Deterministic, no LLM.
 *
 * Account, strongest evidence first:
 *   1 credit note      → the coding of the invoice it reverses (creditNoteRef)
 *   2 discount line    → the coding of the line it reduces (a negative line on a positive invoice)
 *   3 correction       → a person recently re-coded this vendor's lines like this one
 *   4 vendor + words   → this vendor's past lines described like this one ("Racking" ≠ "Pallets")
 *   5 vendor           → this vendor's recent lines ("12 of the last 12")
 *   6 vendor default   → vendors.default_gl_account, for a vendor with no coded history
 *   7 category         → what other vendors in the vendor's category are coded to
 *   8 similar lines    → other vendors' lines described like this one (unknown vendor)
 * Department: the invoice's own department (intake), else the requester's, else the referenced
 * PO's. In the history the line department is the requester's department on every one of the
 * 809 lines, so those are certain. Without them: a credit note's original, the vendor's only
 * open PO, then the vendor's history — marked low when the vendor bills several departments.
 */

const RANK: Record<CodingConfidence, number> = { none: 0, low: 1, medium: 2, high: 3 };
const atMost = (a: CodingConfidence, b: CodingConfidence): CodingConfidence => (RANK[a] <= RANK[b] ? a : b);

const isExpense = (ctx: CodingContext, gl: string) => ctx.glAccounts.get(gl)?.type === "expense";
const accountLabel = (ctx: CodingContext, gl: string) => {
  const a = ctx.glAccounts.get(gl);
  return a ? `${a.number} ${a.name}` : gl;
};
const deptLabel = (ctx: CodingContext, id: string) => {
  const d = ctx.departments.get(id);
  return d ? `${d.name} (${d.id})` : id;
};

function confidenceFor(agreeing: number, total: number): CodingConfidence {
  const share = agreeing / total;
  if (total >= CFG.highMinCount && share >= CFG.highShare) return "high";
  if (share >= CFG.mediumShare) return "medium";
  return "low";
}

interface Tally {
  value: string;
  count: number;
  /** The most recent line that voted for it (lines arrive newest first). */
  example: IndexedLine;
}

function tally(lines: readonly IndexedLine[], pick: (l: IndexedLine) => string): Tally[] {
  const byValue = new Map<string, Tally>();
  for (const l of lines) {
    const v = pick(l);
    const t = byValue.get(v);
    if (t) t.count++;
    else byValue.set(v, { value: v, count: 1, example: l });
  }
  return [...byValue.values()].sort((a, b) => b.count - a.count); // stable: ties keep the most recent first
}

const alternativesOf = (tallies: readonly Tally[], label: (v: string) => string, skip: string): CodingAlternative[] =>
  tallies.filter((t) => t.value !== skip).map((t) => ({ value: t.value, label: label(t.value), count: t.count }));

function account(ctx: CodingContext, basis: AccountBasis, value: string | null, confidence: CodingConfidence, reason: string, alternatives: CodingAlternative[] = []): AccountSuggestion {
  return { value, label: value ? accountLabel(ctx, value) : null, confidence: value ? confidence : "none", basis: value ? basis : "none", reason, alternatives };
}

function department(ctx: CodingContext, basis: DepartmentBasis, value: string | null, confidence: CodingConfidence, reason: string, alternatives: CodingAlternative[] = []): DepartmentSuggestion {
  return { value, label: value ? deptLabel(ctx, value) : null, confidence: value ? confidence : "none", basis: value ? basis : "none", reason, alternatives };
}

interface LineFacts {
  line: ValidationLine;
  tokens: string[];
}

/** The coded line most like this one (ties → the larger amount, then the earlier line). */
function closest(tokens: readonly string[], lines: readonly IndexedLine[], ctx: CodingContext): IndexedLine | undefined {
  let best: IndexedLine | undefined;
  let bestScore = -1;
  for (const l of lines) {
    const s = similarity(tokens, l.tokens, ctx.history.idf);
    if (s > bestScore || (s === bestScore && best && Math.abs(l.amountCents) > Math.abs(best.amountCents))) {
      best = l;
      bestScore = s;
    }
  }
  return best;
}

// --- account ---------------------------------------------------------------------------------

/**
 * The same product bought from other vendors: at least two past lines described almost exactly
 * like this one (similarity ≥ nearIdentical), agreeing on an account. Strong enough to beat a
 * vendor's habit (an office-supply vendor's "Ergonomic task chairs" → furniture), never "high":
 * it is someone else's history.
 */
function sameProductElsewhere(f: LineFacts, ctx: CodingContext, prefix: string): AccountSuggestion | null {
  if (f.tokens.length === 0) return null;
  const close = ctx.history
    .linesSharingWords(f.tokens)
    .filter((l) => isExpense(ctx, l.glAccount))
    .map((l) => ({ l, s: similarity(f.tokens, l.tokens, ctx.history.idf) }))
    .filter((x) => x.s >= CFG.nearIdentical)
    .sort((a, b) => b.s - a.s);
  const example = close[0]?.l;
  if (!example || close.length < 2) return null; // one line elsewhere is an anecdote
  const ranked = tally(close.map((x) => x.l), (l) => l.glAccount);
  const [top, ...rest] = ranked;
  if (!top || top.count / close.length < CFG.highShare) return null; // they disagree: no "same product" answer
  const from = ctx.vendors.get(example.vendorId)?.legalName ?? example.vendorId;
  return account(
    ctx,
    "description_similarity",
    top.value,
    "medium",
    `${prefix}; ${top.count} of ${close.length} past lines described like "${clip(f.line.description)}" (e.g. "${clip(example.description)}" from ${from}) were coded ${accountLabel(ctx, top.value)}`,
    alternativesOf(rest, (v) => accountLabel(ctx, v), top.value),
  );
}

/**
 * Word vote, for a vendor with no usable history: each word that (almost) always means one
 * account votes for it ("ltl" → 5010 on hundreds of lines); words that appear under many
 * accounts ("toronto", "service") are ignored. Medium only with two or more agreeing words, one
 * of them well attested, and a clear winner ("ltl" + "shipment"); a single word ("data") is a
 * guess, so low. Never used against a known vendor's own history.
 */
function fromWords(f: LineFacts, ctx: CodingContext, prefix: string): AccountSuggestion | null {
  const scores = new Map<string, { score: number; words: { word: string; count: number; total: number }[] }>();
  for (const word of f.tokens) {
    const lines = ctx.history.linesWithWord(word).filter((l) => isExpense(ctx, l.glAccount));
    const [top] = tally(lines, (l) => l.glAccount);
    if (!top || top.count / lines.length < CFG.wordPurity) continue;
    const entry = scores.get(top.value) ?? { score: 0, words: [] };
    entry.score += (top.count / lines.length) * Math.log(1 + lines.length);
    entry.words.push({ word, count: top.count, total: lines.length });
    scores.set(top.value, entry);
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1].score - a[1].score);
  const [best, second] = ranked;
  if (!best) return null;
  const [gl, { score, words }] = best;
  const attested = Math.max(...words.map((w) => w.total));
  const clear = !second || score >= 2 * second[1].score;
  const list = words.map((w) => `"${w.word}" (${w.count} of ${w.total})`).join(", ");
  return account(
    ctx,
    "description_similarity",
    gl,
    words.length >= 2 && attested >= CFG.wordMinLines && clear ? "medium" : "low",
    `${prefix}; past lines with the word${words.length === 1 ? "" : "s"} ${list} were coded ${accountLabel(ctx, gl)}`,
    ranked.slice(1).map(([v, e]) => ({ value: v, label: accountLabel(ctx, v), count: Math.max(...e.words.map((w) => w.count)) })),
  );
}

/** "past lines most like … were coded 5040 …: 7 of 7" — the evidence part of a similar-lines reason. */
const whyElsewhere = (s: AccountSuggestion) => s.reason.slice(s.reason.indexOf("; ") + 2);

function suggestAccount(f: LineFacts, vendor: CodingVendorRef | undefined, original: readonly IndexedLine[] | null, ctx: CodingContext): AccountSuggestion {
  const vendorName = vendor?.legalName ?? "this vendor";

  // 1. A credit note is coded like the invoice it reverses.
  const originals = (original ?? []).filter((l) => isExpense(ctx, l.glAccount));
  const source = closest(f.tokens, originals, ctx);
  if (source) {
    return account(
      ctx,
      "credit_note_original",
      source.glAccount,
      "high",
      `Reverses ${vendorName} invoice ${source.invoiceNumber ?? source.invoiceId} (${source.invoiceId}): its line "${clip(source.description)}" was coded ${accountLabel(ctx, source.glAccount)}`,
    );
  }

  const evidence = vendor ? ctx.history.vendorLines(vendor.id).filter((l) => isExpense(ctx, l.glAccount)) : [];
  // The same product at other vendors: may beat this vendor's habit; the answer for an unknown vendor.
  const prefix = vendor ? `No usable history for ${vendorName}` : "Unknown vendor";
  const elsewhere = sameProductElsewhere(f, ctx, prefix);

  if (evidence.length > 0) {
    // 3 + 4. This vendor's lines described like this one.
    const similar = evidence.filter((l) => similarity(f.tokens, l.tokens, ctx.history.idf) >= CFG.similarLine).slice(0, CFG.window);
    const latest = similar[0];
    if (latest && latest.source === "changed") {
      let run = 0;
      for (const l of similar) {
        if (l.source === "changed" && l.glAccount === latest.glAccount) run++;
        else break;
      }
      const others = tally(similar.slice(run), (l) => l.glAccount);
      return account(
        ctx,
        "recent_correction",
        latest.glAccount,
        run >= 2 ? "high" : "medium",
        `A person re-coded ${vendorName}'s latest ${run === 1 ? "line" : `${run} lines`} like "${clip(latest.description)}" to ${accountLabel(ctx, latest.glAccount)}` +
          (others[0] && others[0].value !== latest.glAccount ? ` (earlier ones went to ${accountLabel(ctx, others[0].value)})` : ""),
        alternativesOf(others, (v) => accountLabel(ctx, v), latest.glAccount),
      );
    }
    if (latest) {
      const [top, ...rest] = tally(similar, (l) => l.glAccount);
      if (top) {
        return account(
          ctx,
          "vendor_description",
          top.value,
          confidenceFor(top.count, similar.length),
          `${top.count} of the last ${similar.length} ${vendorName} lines like "${clip(top.example.description)}" → ${accountLabel(ctx, top.value)}`,
          alternativesOf(rest, (v) => accountLabel(ctx, v), top.value),
        );
      }
    }
    // 5. This vendor's recent lines, whatever they said. If this description is new to the
    // vendor and lines like it at other vendors strongly agree on another account, the specific
    // description beats the broad vendor habit (an office-supply vendor's "task chairs" → furniture;
    // Keystone's "stretch wrap" → packaging although it also bills racking).
    const recent = evidence.slice(0, CFG.window);
    const ranked = tally(recent, (l) => l.glAccount);
    const [top, ...rest] = ranked;
    if (top) {
      const usage = ranked.map((t) => `${accountLabel(ctx, t.value)} ${t.count}`).join(", ");
      if (elsewhere?.value && elsewhere.value !== top.value && RANK[elsewhere.confidence] >= RANK.medium) {
        return account(
          ctx,
          "description_similarity",
          elsewhere.value,
          "medium",
          `"${clip(f.line.description)}" is new for ${vendorName} (its last ${recent.length} lines: ${usage}); ${whyElsewhere(elsewhere)}`,
          alternativesOf(ranked, (v) => accountLabel(ctx, v), elsewhere.value),
        );
      }
      // A kind of line this vendor never billed before: at most medium, so a person looks at it
      // (bulk-accept only covers kinds of lines seen before).
      return account(
        ctx,
        "vendor_history",
        top.value,
        atMost(confidenceFor(top.count, recent.length), "medium"),
        `${top.count} of the last ${recent.length} ${vendorName} lines → ${accountLabel(ctx, top.value)} (none described like "${clip(f.line.description)}" before)`,
        alternativesOf(rest, (v) => accountLabel(ctx, v), top.value),
      );
    }
  }

  // 6. Vendor master default — unless lines described like this one strongly say otherwise.
  if (vendor?.defaultGlAccount && isExpense(ctx, vendor.defaultGlAccount)) {
    const fallback = { value: vendor.defaultGlAccount, label: accountLabel(ctx, vendor.defaultGlAccount), count: 0 };
    if (elsewhere?.value && elsewhere.value !== vendor.defaultGlAccount && RANK[elsewhere.confidence] >= RANK.medium) {
      return account(
        ctx,
        "description_similarity",
        elsewhere.value,
        "medium",
        `No coded history for ${vendor.legalName} yet and its default account is ${fallback.label}, but ${whyElsewhere(elsewhere)}`,
        [fallback],
      );
    }
    return account(ctx, "vendor_default", vendor.defaultGlAccount, "medium", `No coded history for ${vendor.legalName} yet; its vendor-master default account is ${fallback.label}`);
  }

  // 7. Other vendors in the same category.
  if (vendor) {
    const peers = [...ctx.vendors.values()].filter((v) => v.id !== vendor.id && v.category === vendor.category && v.defaultGlAccount && isExpense(ctx, v.defaultGlAccount));
    const counts = new Map<string, number>();
    for (const p of peers) counts.set(p.defaultGlAccount!, (counts.get(p.defaultGlAccount!) ?? 0) + 1);
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const top = ranked[0];
    if (top) {
      return account(
        ctx,
        "category",
        top[0],
        "low",
        `No history or default account for ${vendor.legalName}; ${top[1]} of ${peers.length} other ${vendor.category} vendors are coded to ${accountLabel(ctx, top[0])}`,
        ranked.slice(1).map(([v, n]) => ({ value: v, label: accountLabel(ctx, v), count: n })),
      );
    }
  }

  // 8. The same product elsewhere, else what the words usually mean.
  if (elsewhere) return elsewhere;
  const byWords = fromWords(f, ctx, prefix);
  if (byWords) return byWords;
  return account(ctx, "none", null, "none", `No coded history, default account or similar past line for "${clip(f.line.description)}": code it by hand`);
}

// --- department ------------------------------------------------------------------------------

/** The department of the whole invoice when something authoritative says it. */
function knownInvoiceDepartment(input: ValidationInput, ctx: CodingContext): DepartmentSuggestion | null {
  if (input.departmentId && ctx.departments.has(input.departmentId)) {
    return department(ctx, "invoice", input.departmentId, "high", `The invoice is assigned to ${deptLabel(ctx, input.departmentId)}`);
  }
  if (input.requesterId) {
    const u = ctx.users.get(input.requesterId);
    if (u && ctx.departments.has(u.departmentId)) {
      return department(ctx, "requester", u.departmentId, "high", `Requested by ${u.fullName}, who works in ${deptLabel(ctx, u.departmentId)}`);
    }
  }
  if (input.poNumber) {
    const po = ctx.purchaseOrders.find((p) => normalizeDocNumber(p.id) === normalizeDocNumber(input.poNumber!));
    if (po?.departmentId && ctx.departments.has(po.departmentId)) {
      return department(ctx, "purchase_order", po.departmentId, "high", `${po.id} was raised for ${deptLabel(ctx, po.departmentId)}`);
    }
  }
  return null;
}

function suggestLineDepartment(f: LineFacts, vendor: CodingVendorRef | undefined, original: readonly IndexedLine[] | null, ctx: CodingContext): DepartmentSuggestion {
  const vendorName = vendor?.legalName ?? "this vendor";
  const source = closest(f.tokens, (original ?? []).filter((l) => ctx.departments.has(l.departmentId)), ctx);
  if (source) {
    return department(ctx, "credit_note_original", source.departmentId, "high", `Reverses invoice ${source.invoiceNumber ?? source.invoiceId}, which was charged to ${deptLabel(ctx, source.departmentId)}`);
  }
  if (!vendor) return department(ctx, "none", null, "none", "Unknown vendor and no requester or PO: pick the requesting department");

  const history = ctx.history.vendorLines(vendor.id).filter((l) => ctx.departments.has(l.departmentId));
  const historyAlternatives = (skip: string) => alternativesOf(tally(history.slice(0, CFG.window), (l) => l.departmentId), (v) => deptLabel(ctx, v), skip);

  const openPos = ctx.purchaseOrders.filter((p) => p.vendorId === vendor.id && p.status !== "closed" && p.departmentId && ctx.departments.has(p.departmentId));
  const onlyPo = openPos.length === 1 ? openPos[0] : undefined;
  if (onlyPo?.departmentId) {
    return department(
      ctx,
      "open_purchase_order",
      onlyPo.departmentId,
      "medium",
      `${vendorName} has one open PO, ${onlyPo.id}, raised for ${deptLabel(ctx, onlyPo.departmentId)}; the invoice does not reference it`,
      historyAlternatives(onlyPo.departmentId),
    );
  }
  if (history.length === 0) return department(ctx, "none", null, "none", `No requester, PO or history for ${vendorName}: pick the requesting department`);

  const similar = history.filter((l) => similarity(f.tokens, l.tokens, ctx.history.idf) >= CFG.similarLine).slice(0, CFG.window);
  const pool = similar.length > 0 ? similar : history.slice(0, CFG.window);
  const basis: DepartmentBasis = similar.length > 0 ? "vendor_description" : "vendor_history";
  const ranked = tally(pool, (l) => l.departmentId);
  const [top, ...rest] = ranked;
  if (!top) return department(ctx, "none", null, "none", `No usable history for ${vendorName}: pick the requesting department`);
  const confidence = confidenceFor(top.count, pool.length);
  const like = basis === "vendor_description" ? ` like "${clip(top.example.description)}"` : "";
  const reason =
    confidence === "low"
      ? `${vendorName} bills several departments (${ranked.map((t) => `${deptLabel(ctx, t.value)} ${t.count}`).join(", ")} of its last ${pool.length} lines${like}): pick the requesting department`
      : `${top.count} of the last ${pool.length} ${vendorName} lines${like} → ${deptLabel(ctx, top.value)}`;
  return department(ctx, basis, top.value, confidence, reason, alternativesOf(rest, (v) => deptLabel(ctx, v), top.value));
}

/** One department for the whole invoice, from the lines' suggestions (weighted by amount). */
function aggregateDepartment(lines: readonly LineCoding[], currency: string | null, ctx: CodingContext): DepartmentSuggestion {
  const weights = new Map<string, number>();
  for (const l of lines) if (l.department.value) weights.set(l.department.value, (weights.get(l.department.value) ?? 0) + Math.max(Math.abs(l.amountCents), 1));
  const ranked = [...weights.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  if (!top) {
    const first = lines[0]?.department;
    return first ?? department(ctx, "none", null, "none", "No lines to infer a department from: pick the requesting department");
  }
  if (ranked.length === 1) {
    const best = lines.filter((l) => l.department.value === top[0]).sort((a, b) => RANK[b.department.confidence] - RANK[a.department.confidence])[0]!;
    return best.department;
  }
  return department(
    ctx,
    lines.find((l) => l.department.value === top[0])!.department.basis,
    top[0],
    "low",
    `The lines point at different departments (${ranked.map(([d, w]) => `${deptLabel(ctx, d)} ${formatMoney(w, currency)}`).join(", ")}): pick the requesting department`,
    ranked.slice(1).map(([d]) => ({ value: d, label: deptLabel(ctx, d), count: 0 })),
  );
}

// --- the whole invoice -----------------------------------------------------------------------

function lineCoding(line: ValidationLine, acc: AccountSuggestion, dept: DepartmentSuggestion): LineCoding {
  return {
    lineNo: line.lineNo,
    description: line.description,
    quantity: line.quantity,
    unitPriceCents: line.unitPriceCents,
    amountCents: line.amountCents,
    lineType: line.lineType,
    account: acc,
    department: dept,
    glAccount: acc.value,
    departmentId: dept.value,
    source: "suggested",
    codedBy: null,
    codedAt: null,
    note: null,
  };
}

/**
 * Suggests coding for every line. `vendorId` is the vendor validation's `matchVendor` resolved
 * (null = unknown vendor). Throws only if `rawInput` does not satisfy the ValidationInput contract.
 */
export function suggestCoding(rawInput: ValidationInputDraft | ValidationInput, vendorId: string | null, ctx: CodingContext): CodingResult {
  const input = ValidationInput.parse(rawInput);
  const vendor = vendorId ? ctx.vendors.get(vendorId) : undefined;
  const flags: Flag[] = [];
  const isCredit = input.documentType === "credit_note" || (input.totalCents !== null && input.totalCents < 0);
  const original = isCredit && vendor && input.creditNoteRef ? ctx.history.documentLines(vendor.id, input.creditNoteRef) : null;
  const known = knownInvoiceDepartment(input, ctx);

  // Positive lines (and every line of a credit note) first; discounts follow the line they reduce.
  const facts = input.lines.map((line) => ({ line, tokens: tokenize(line.description) }));
  const isDiscount = (f: LineFacts) => !isCredit && f.line.amountCents < 0;
  const coded = new Map<number, LineCoding>();
  for (const f of facts.filter((x) => !isDiscount(x))) {
    coded.set(f.line.lineNo, lineCoding(f.line, suggestAccount(f, vendor, original, ctx), known ?? suggestLineDepartment(f, vendor, original, ctx)));
  }
  const parent = [...coded.values()].filter((c) => c.amountCents > 0).sort((a, b) => b.amountCents - a.amountCents)[0];
  for (const f of facts.filter(isDiscount)) {
    if (parent?.account.value) {
      const why = `A discount reduces the cost it applies to: coded like line ${parent.lineNo} ("${clip(parent.description)}")`;
      coded.set(
        f.line.lineNo,
        lineCoding(
          f.line,
          { ...parent.account, basis: "discount_parent", reason: why, alternatives: [] },
          known ?? { ...parent.department, basis: parent.department.value ? "discount_parent" : "none", reason: parent.department.value ? why : parent.department.reason, alternatives: [] },
        ),
      );
    } else {
      coded.set(f.line.lineNo, lineCoding(f.line, suggestAccount(f, vendor, original, ctx), known ?? suggestLineDepartment(f, vendor, original, ctx)));
    }
  }
  const lines = input.lines.map((l) => coded.get(l.lineNo)!);

  const invoiceDepartment = known ?? aggregateDepartment(lines, input.currency, ctx);

  // Findings.
  if (lines.length === 0) {
    // Still say where the vendor's invoices usually go, so the clerk can enter one line.
    const whole: ValidationLine = { lineNo: 1, description: "", quantity: 1, unitPriceCents: input.subtotalCents ?? 0, amountCents: input.subtotalCents ?? 0, lineType: null };
    const usual = suggestAccount({ line: whole, tokens: [] }, vendor, original, ctx);
    const total = input.totalCents === null ? "an unknown total" : formatMoney(input.totalCents, input.currency);
    flags.push(
      codingFlag(
        "CODING_NO_LINES",
        `No line items were extracted from this invoice (${total}); enter the lines${usual.value ? ` (this vendor's lines usually go to ${usual.label})` : ""}.`,
        { field: "lines", suggestedAccount: usual.value },
      ),
    );
  }
  for (const l of lines) {
    if (!l.account.value) flags.push(codingFlag("CODING_NO_SUGGESTION", `Line ${l.lineNo} "${clip(l.description)}": ${l.account.reason}.`, { field: "lines", lineNo: l.lineNo }));
    flags.push(...reviewLine(l, ctx, input.currency));
  }
  if (!known && lines.length > 0 && RANK[invoiceDepartment.confidence] <= RANK.low) {
    flags.push(codingFlag("CODING_DEPARTMENT_UNCERTAIN", `${invoiceDepartment.reason}.`, { field: "department", candidates: [invoiceDepartment.value, ...invoiceDepartment.alternatives.map((a) => a.value)].filter(Boolean) }));
  }
  const { journal, flags: journalFlags } = buildJournal(input, lines, ctx);
  flags.push(...journalFlags);

  return { invoiceId: input.invoiceId, vendorId: vendor?.id ?? null, invoiceDepartment, lines, journal, flags };
}
