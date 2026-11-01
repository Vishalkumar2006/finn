import { z } from "zod";

/**
 * Checks on a model's answer before anyone sees it. Each claim is tested only against the passages it cites, so a
 * number that exists elsewhere in the evidence does not pass, and a citation has to actually support its claim.
 * These are necessary checks, not proof of truth: a claim can pass them and still misread its source.
 */

export const ModelAnswer = z.object({
  status: z.enum(["answered", "abstain"]),
  claims: z.array(z.object({ text: z.string().trim().min(1).max(500), citations: z.array(z.number().int()).max(6) })).max(6).default([]),
  reason: z.string().max(300).optional(),
});
export type ModelAnswer = z.infer<typeof ModelAnswer>;

export type CheckResult =
  | { ok: true; status: "answered"; claims: { text: string; citations: number[] }[] }
  | { ok: true; status: "abstain"; reason: string }
  | { ok: false; reason: string };

/** Models often wrap JSON in a code fence, despite instructions. */
export function parseModelAnswer(raw: string): ModelAnswer | null {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const r = ModelAnswer.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/* ---------- numbers ---------- */

const normNum = (s: string) => {
  const n = s.replace(/,/g, "");
  return n.includes(".") ? n.replace(/0+$/, "").replace(/\.$/, "") : n;
};

/** Fiscal labels are compared whole, so "FY27" cannot be justified by a stray 27 or by "Q2" somewhere. */
const FY = /\bF\.?Y\.?\s?['’]?\s?(?:(?:20)?\d{2}\s?[-–]\s?)?(?:20)?(\d{2})\b/gi;
const YEAR_SPAN = /\b20\d{2}\s?[-–]\s?(?:20)?(\d{2})\b/g;

function fiscalTokens(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(FY)) out.push(`FY${m[1]}`);
  for (const m of s.matchAll(YEAR_SPAN)) out.push(`FY${m[1]}`); // Indian reports write FY26 as 2025-26
  for (const m of s.matchAll(/\b(?:\d?Q|quarter\s)([1-4])\b/gi)) out.push(`Q${m[1]}`);
  return out;
}

const stripFiscal = (s: string) => s.replace(FY, " ").replace(YEAR_SPAN, " ").replace(/\b\d?Q[1-4]\b/gi, " ");

function numbersIn(s: string): string[] {
  return (stripFiscal(s).match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map(normNum);
}

export function unsupportedNumbers(claim: string, evidence: string): string[] {
  const known = new Set(numbersIn(evidence));
  const fiscal = new Set(fiscalTokens(evidence));
  // A passage saying "fiscal 2027" or "financial year 2027" supports FY27.
  for (const m of evidence.matchAll(/\b(?:fiscal|financial year)\s+(?:20)?(\d{2})\b/gi)) fiscal.add(`FY${m[1]}`);
  const bad = numbersIn(claim).filter((n) => !known.has(n));
  // Word forms such as "fourth quarter" are not normalised in evidence, so only numeric Q labels are enforced.
  const badFiscal = fiscalTokens(claim).filter((t) => !fiscal.has(t) && !(t.startsWith("Q") && !/\bQ[1-4]\b/i.test(evidence) && /quarter/i.test(evidence)));
  return [...bad, ...badFiscal];
}

/* ---------- wording ---------- */

const STOP = new Set("a an and are as at be been but by can could did do does for from had has have how if in into is it its of on or our so than that the their them there these they this to was we were what when where which who why will with would you your not no also more most other such than then very may might should expects expected expect said says management company stated noted according".split(" "));

const stem = (w: string) => w.replace(/(ing|ed|es|s|ly|ment|tion|ions)$/, "");

function contentWords(s: string): string[] {
  return (s.toLowerCase().match(/[a-z][a-z-]{2,}/g) ?? []).filter((w) => !STOP.has(w)).map(stem);
}

/** Share of the claim's content words present in its cited passages. Low overlap means it is not from them. */
export function overlap(claim: string, evidence: string): number {
  const words = contentWords(claim);
  if (!words.length) return 0;
  const known = new Set(contentWords(evidence));
  return words.filter((w) => known.has(w)).length / words.length;
}

/** Names and acronyms must come from the cited text: this catches outside knowledge. */
const MONTH = /^(January|February|March|April|May|June|July|August|September|October|November|December)$/;

export function unknownNames(claim: string, evidence: string): string[] {
  const hay = evidence.toLowerCase().replace(/-\s+/g, "-"); // PDF line breaks split hyphenated words
  const out: string[] = [];
  // Skip the first word of each sentence, which is capitalised regardless.
  for (const sentence of claim.split(/(?<=[.!?])\s+/)) {
    const words = sentence.split(/\s+/).slice(1);
    for (const raw of words) {
      const w = raw.replace(/[^A-Za-z&-]/g, "");
      if (w.length < 3 || !/^[A-Z]/.test(w) || /^(FY|Q[1-4]|Management|Company)$/i.test(w)) continue;
      // Source labels abbreviate months: "August" is supported by "Aug 2026".
      if (MONTH.test(w) ? !hay.includes(w.slice(0, 3).toLowerCase()) : !hay.includes(w.toLowerCase())) out.push(w);
    }
  }
  return out;
}

const UP = /\b(increas|rais|ris|grow|grew|expand|improv|higher|strengthen|accelerat|upgrad)/i;
const DOWN = /\b(decreas|reduc|fall|fell|declin|lower|contract|compress|weak|slow|cut|downgrad|drop|shrink)/i;

/** A claim of decline must cite a passage that speaks of decline, and likewise for growth. */
export function directionUnsupported(claim: string, evidence: string): string | null {
  if (DOWN.test(claim) && !DOWN.test(evidence)) return "claims a decline its source does not mention";
  if (UP.test(claim) && !UP.test(evidence)) return "claims an increase its source does not mention";
  return null;
}

/** Verdicts belong to filed numbers. The model may not hand down its own, unless the source says it verbatim. */
const VERDICT = /\b(missed|exceeded|beat|fell short|underdeliver|failed to (meet|deliver|achieve)|met (its|their|the) (guidance|target))\w*\b/i;

// Synthesis paraphrases, so this can't be strict. It stops claims unrelated to their citation, not subtle misreadings.
const MIN_OVERLAP = 0.5;

export function checkAnswer(a: ModelAnswer, passages: string[]): CheckResult {
  if (a.status === "abstain") return { ok: true, status: "abstain", reason: a.reason ?? "The passages do not answer this." };
  if (!a.claims.length) return { ok: false, reason: "no claims" };
  for (const c of a.claims) {
    if (!c.citations.length) return { ok: false, reason: "a claim has no citation" };
    if (c.citations.some((n) => n < 1 || n > passages.length)) return { ok: false, reason: "a citation points to no supplied passage" };
    const evidence = c.citations.map((n) => passages[n - 1]).join(" ");
    const nums = unsupportedNumbers(c.text, evidence);
    if (nums.length) return { ok: false, reason: `${nums.join(", ")} not in the cited passage` };
    const names = unknownNames(c.text, evidence);
    if (names.length) return { ok: false, reason: `${names.slice(0, 3).join(", ")} not in the cited passage` };
    const dir = directionUnsupported(c.text, evidence);
    if (dir) return { ok: false, reason: `a claim ${dir}` };
    const v = c.text.match(VERDICT);
    if (v && !evidence.toLowerCase().includes(v[0].toLowerCase())) return { ok: false, reason: "the model issued its own verdict" };
    const o = overlap(c.text, evidence);
    if (o < MIN_OVERLAP) return { ok: false, reason: `a claim is not supported by its citation (${Math.round(o * 100)}% word overlap)` };
  }
  return { ok: true, status: "answered", claims: a.claims.map((c) => ({ text: c.text, citations: [...new Set(c.citations)] })) };
}

/** Keeps only cited passages and renumbers them 1..n in order of first use, so chips match the text. */
export function renumber(claims: { text: string; citations: number[] }[]): { lines: string[]; used: number[] } {
  const used: number[] = [];
  const lines = claims.map((c) => {
    const marks = c.citations.map((n) => {
      if (!used.includes(n)) used.push(n);
      return `[${used.indexOf(n) + 1}]`;
    });
    return `${c.text.replace(/\s*\[\d+\]/g, "").trim()} ${marks.join("")}`;
  });
  return { lines, used };
}

/** Passages are untrusted: they must not be able to close their own delimiter. */
export const sanitisePassage = (s: string) => s.replace(/<\/?\s*passage[^>]*>/gi, " ");
