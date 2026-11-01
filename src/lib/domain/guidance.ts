import { fiscalLabel, marginPct, pctChange, priorQuarterEnd, yearAgoEnd } from "./metrics";
import type { FiscalPeriod, GuidanceClaim, GuidanceMetric, GuidanceStatus, PeriodFacts } from "./types";

/* ---------- transcript structure ---------- */

export interface Turn {
  speaker: string;
  text: string;
  page: number;
  section?: string; // a product-line heading seen inside this turn, e.g. "Refrigerators:"
  spans: { page: number; text: string }[]; // where the text actually sits, since turns cross page breaks
}

const SPEAKER = /^([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]*){0,4})\s*:\s*(.*)$/;
const PRODUCT_HEADING = /\b(phones?|refrigerators?|lighting|appliances|electronics|segment|business|division|vertical|products?|wearables|solutions|washing|machines?|systems?)\b/i;
const NOT_SPEAKERS = /^(note|disclaimer|management|moderator note|participants?|safe harbor|forward looking|page|date|time|email|website|cin|registered office)$/i;

/** Split a transcript into speaker turns, tracking the PDF page each begins on. */
export function parseTurns(pages: string[]): Turn[] {
  const counts = new Map<string, number>();
  for (const p of pages) {
    for (const line of p.split("\n")) {
      const m = line.trim().match(SPEAKER);
      if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
  }
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  pages.forEach((p, i) => {
    for (const line of p.split("\n")) {
      const m = line.trim().match(SPEAKER);
      // People speak repeatedly. A label seen once is a slide-style heading, unless it reads as a two-word name.
      const isPerson = m && !NOT_SPEAKERS.test(m[1]) && !PRODUCT_HEADING.test(m[1]) && ((counts.get(m[1]) ?? 0) > 1 || /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(m[1]));
      if (isPerson) {
        if (cur) turns.push(cur);
        cur = { speaker: m[1], text: m[2], page: i + 1, spans: [{ page: i + 1, text: m[2] }] };
      } else if (m && cur && !NOT_SPEAKERS.test(m[1])) {
        turns.push(cur);
        cur = { speaker: cur.speaker, text: m[2], page: i + 1, section: m[1], spans: [{ page: i + 1, text: m[2] }] };
      } else if (cur) {
        cur.text += ` ${line.trim()}`;
        cur.spans.push({ page: i + 1, text: line.trim() });
      }
    }
  });
  if (cur) turns.push(cur);
  return turns;
}

/**
 * Analysts are whoever the moderator hands the line to, or whoever mostly asks questions.
 * Their words are never treated as management guidance.
 */
export function managementSpeakers(turns: Turn[]): Set<string> {
  const analysts = new Set<string>();
  const stats = new Map<string, { q: number; words: number }>();
  for (const t of turns) {
    if (/moderator|operator/i.test(t.speaker)) {
      const m = t.text.match(/(?:question|next question|comes?|from the line of|line of)\s+(?:is\s+)?(?:from\s+)?(?:the line of\s+)?([A-Z][a-z]+(?: [A-Z][a-z]+){0,3})/);
      if (m) analysts.add(m[1].split(" ")[0].toLowerCase());
      continue;
    }
    const s = stats.get(t.speaker) ?? { q: 0, words: 0 };
    s.q += (t.text.match(/\?/g) ?? []).length;
    s.words += t.text.split(/\s+/).length;
    stats.set(t.speaker, s);
  }
  const mgmt = new Set<string>();
  for (const [name, s] of stats) {
    const first = name.split(" ")[0].toLowerCase();
    if (analysts.has(first)) continue;
    if (s.q > 0 && s.words / s.q < 60) continue; // question-heavy speakers
    mgmt.add(name);
  }
  return mgmt;
}

/** Per-page text with analysts and the moderator removed. Falls back to all text if speakers cannot be told apart. */
export function managementPages(pages: string[]): string[] {
  const turns = parseTurns(pages);
  const mgmt = managementSpeakers(turns);
  if (!mgmt.size) return pages;
  const out = pages.map(() => "");
  for (const t of turns) {
    if (!mgmt.has(t.speaker)) continue;
    for (const sp of t.spans) out[sp.page - 1] += ` ${sp.text}`;
  }
  return out;
}

/** The page a sentence starts on. A quote's page is what a reader will check, so it must not be the turn's start. */
function pageOf(t: Turn, sentence: string): number {
  const squash = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  const head = squash(sentence).slice(0, 24);
  let acc = "";
  for (const sp of t.spans) {
    acc += squash(sp.text);
    if (acc.includes(head)) return sp.page;
  }
  return t.page;
}

/* ---------- guidance candidates ---------- */

const FORWARD = /\b(guidance|guide[ds]?|we (would |should |will |shall )?(expect|target|aim|anticipate|plan|estimate|intend|are confident|are targeting|are looking at|aspire)|(expect|target|outlook|aspiration|ambition) (of|is|to|for)|should be (able|in|around|at)|will be (in the range|around|at|between)|would be (in the range|around|at|between)|we are looking at|going forward|we will (deliver|achieve|grow|maintain|sustain|invest|spend)|likely to|on track to)\b/i;
const BACKWARD = /\b(in line with|well within|have already|has already|already (pumped|spent|invested)|if you (remove|exclude)|last (quarter|year)|previous (quarter|year)|we (delivered|reported|achieved|grew|recorded|posted|saw)|was (up|down|at)|were (up|down|at)|has (grown|increased|declined)|for the quarter ended)\b/i;
const FILLER = /\bsafe harbou?r|forward[- ]looking statements?|actual results may differ|risks and uncertainties\b/i;

function metricOf(s: string): GuidanceMetric {
  const t = s.toLowerCase();
  if (/(revenue|top ?line|sales)[^.]{0,40}(rs\.?|₹|inr)\s*[\d,]+[^.]{0,6}(crore|cr\b)|(rs\.?|₹|inr)\s*[\d,]+[^.]{0,6}(crore|cr\b)[^.]{0,30}(revenue|top ?line|sales)/.test(t)) return "revenue_abs";
  if (/(absolute|growth in|grow)[^.]{0,20}ebitda|ebitda[^.]{0,12}(growth|grow)/.test(t) && !/margin/.test(t)) return "ebitda_growth";
  if (/(pat|net profit|bottom ?line)[^.]{0,14}(growth|grow)|(grow|growth in)[^.]{0,14}(pat|net profit)/.test(t) && !/margin/.test(t)) return "pat_growth";
  if (/ebitda\s*margin|operating margin|ebitda (of|at|to be)/.test(t)) return "ebitda_margin";
  if (/ebit\s*margin/.test(t)) return "ebit_margin";
  if (/pat\s*margin|net (profit )?margin/.test(t)) return "pat_margin";
  if (/\bcapex\b|capital expenditure/.test(t)) return "capex";
  // A lender's AUM or a manufacturer's volume is not revenue, even in a sentence that also says "top line".
  if (/\b(aum|assets under|loan book|loan growth|advances|disbursements?|deposits?|volumes?|tonnage|order ?book)\b/.test(t)) return "other";
  if (/(revenue|top ?line|sales).{0,50}(grow|growth|cagr|increase)|(grow|growth|cagr).{0,50}(revenue|top ?line|sales)/.test(t)) return "revenue_growth";
  return "other";
}

const KNOWN_OTHER = /\b(margin|growth|cagr|nim|net interest margin|credit cost|loan book|advances|deposits?|aum|order ?book|volume|roe|roa|roce|capacity|gross npa|pat|utili[sz]ation|cost[- ]to[- ]income)\b/i;

/** Pull the guided number or range, ignoring years and quarter labels. */
export function parseValue(s: string): { low: number | null; high: number | null; unit: "%" | "INR" | null; floor: boolean } {
  const clean = s.replace(/\bFY\s?\d{2,4}\b/gi, " ").replace(/\bQ[1-4]\b/gi, " ");
  const cr = clean.match(/(?:rs\.?|₹|inr)\s*([\d,]+(?:\.\d+)?)\s*(?:crores?\s*|cr\s*)?(?:(?:-|–|to)\s*(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*)?(crores?|cr\b)/i);
  if (cr) {
    const a = Number(cr[1].replace(/,/g, "")) * 1e7;
    const b = cr[2] ? Number(cr[2].replace(/,/g, "")) * 1e7 : a;
    return { low: a, high: b, unit: "INR", floor: false };
  }
  const range = clean.match(/(\d+(?:\.\d+)?)\s*%?\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)\s*(?:%|per ?cent|percent)/i);
  if (range) return { low: Number(range[1]), high: Number(range[2]), unit: "%", floor: false };
  const one = clean.match(/(at least|minimum|more than|over|above|upwards of|north of|around|about|approximately|~)?\s*(\d+(?:\.\d+)?)\s*(?:%|per ?cent|percent)/i);
  if (one) {
    const v = Number(one[2]);
    const floor = /at least|minimum|more than|over|above|upwards|north/i.test(one[1] ?? "");
    return { low: v, high: floor ? null : v, unit: "%", floor };
  }
  if (/double[- ]digit/i.test(clean)) return { low: 10, high: null, unit: "%", floor: true };
  return { low: null, high: null, unit: null, floor: false };
}

function callQuarter(callDate: string): FiscalPeriod {
  // A call discusses the quarter that ended most recently before it.
  const [y, m] = callDate.split("-").map(Number);
  const qEndMonth = m >= 10 ? 9 : m >= 7 ? 6 : m >= 4 ? 3 : 12;
  const qEndYear = m >= 4 ? y : y - 1;
  const fy = qEndMonth >= 4 ? qEndYear + 1 : qEndYear;
  const q = qEndMonth === 6 ? 1 : qEndMonth === 9 ? 2 : qEndMonth === 12 ? 3 : 4;
  return { kind: "Q", fy, q };
}

/** Period the statement targets, resolved against the call date. Null if it is not stated. */
export function parsePeriod(raw: string, callDate: string): { period: FiscalPeriod | null; text: string | null } {
  // "on the Q4 FY25 earnings call" names when it was said, not what it targets.
  const s = raw.replace(/(?:during |on |in )?(?:the )?\d?Q[1-4]\s*FY\s?'?\d{2,4}\s+(?:earnings |concall |conference )?call/gi, " ");
  const cq = callQuarter(callDate);
  const norm = (n: string) => { const v = Number(n); return v < 100 ? 2000 + v : v; };
  const qfy = s.match(/\b\d?Q([1-4])\s*(?:of\s*)?FY\s?'?(\d{2,4})\b/i);
  if (qfy) return { period: { kind: "Q", q: Number(qfy[1]), fy: norm(qfy[2]) }, text: qfy[0] };
  const fy = s.match(/\bFY\s?'?(\d{2,4})\b|\bfinancial year\s+(20\d{2})\b/i);
  if (fy) return { period: { kind: "FY", fy: norm(fy[1] ?? fy[2]) }, text: fy[0] };
  const nextQ = s.match(/\bnext quarter\b|\bcoming quarter\b/i);
  if (nextQ) {
    const q = cq.q === 4 ? 1 : cq.q! + 1;
    return { period: { kind: "Q", q, fy: cq.q === 4 ? cq.fy + 1 : cq.fy }, text: nextQ[0] };
  }
  const nextY = s.match(/\bnext (fiscal|financial year|year)\b/i);
  if (nextY) return { period: { kind: "FY", fy: cq.q === 4 ? cq.fy + 2 : cq.fy + 1 }, text: nextY[0] };
  const thisY = s.match(/\b(this|current) (fiscal|financial year|year)\b|\bfull year\b/i);
  if (thisY) return { period: { kind: "FY", fy: cq.q === 4 ? cq.fy + 1 : cq.fy }, text: thisY[0] };
  return { period: null, text: null };
}

const SCOPED = /\b(segments?|division|vertical|subsidiary|exports?|domestic business|international business|this business|that business|in the \w+ business|on [A-Z]{3,}\b|for [A-Z]{3,}\b|in [A-Z]{3,}\b)/;

function basisNote(s: string): string | null {
  if (/constant currency|\bcc\b/i.test(s)) return "Guided in constant currency; filings report in INR.";
  if (/\b(usd|dollar|us\$)\b/i.test(s)) return "Guided in USD; filings report in INR.";
  if (SCOPED.test(s)) return "Scope looks narrower than the whole company.";
  if (/\b(medium|long)[- ]term\b|\bover the next (few|\d+|two|three|five) years\b/i.test(s)) return "Multi-year aspiration, no single period to test.";
  if (/\bcagr\b/i.test(s)) return "Multi-year CAGR, no single period to test.";
  return null;
}

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .replace(/(\d)\.(\d)/g, "$1\u0001$2")
    .replace(/\b(Mr|Ms|Mrs|Dr|Rs|No|vs|Ltd|Inc)\./g, "$1\u0002")
    .split(/(?<=[.!?])\s+(?=[A-Z"'(])/)
    .map((s) => s.replace(/\u0001/g, ".").replace(/\u0002/g, ".").trim())
    .filter(Boolean);
}

/** Candidates from one transcript: forward-looking, by management, about a known metric. */
export function extractClaims(pages: string[], callDate: string): GuidanceClaim[] {
  const turns = parseTurns(pages);
  const mgmt = managementSpeakers(turns);
  const out: GuidanceClaim[] = [];
  const seen = new Set<string>();
  for (const t of turns) {
    if (!mgmt.has(t.speaker)) continue;
    const sentences = splitSentences(t.text);
    sentences.forEach((s, si) => {
      if (s.length < 30 || s.length > 450 || s.endsWith("?") || FILLER.test(s)) return;
      if (!FORWARD.test(s) || BACKWARD.test(s)) return;
      const metric = metricOf(s);
      if (metric === "other" && !KNOWN_OTHER.test(s)) return;
      const v = parseValue(s);
      if (v.low == null && metric === "other") return;
      const key = s.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 80);
      if (seen.has(key)) return;
      seen.add(key);
      let { period, text } = parsePeriod(s, callDate);
      let periodInferred = false;
      if (!period && si > 0) {
        // The speaker often names the period in the sentence before. Shown as inferred in the UI.
        const prev = parsePeriod(sentences[si - 1], callDate);
        if (prev.period) { period = prev.period; text = prev.text; periodInferred = true; }
      }
      // A target period that ended before the call is a report or a recollection, not guidance.
      if (period && periodEndOf(period) < callDate) return;
      const scoped = t.section ? `Said under the "${t.section}" heading, not the whole company.` : si > 0 && SCOPED.test(sentences[si - 1]) ? "Preceding sentence is about part of the business." : null;
      out.push({
        metric, ...v, period, periodText: text, periodInferred,
        comparison: /sequential|quarter[- ]on[- ]quarter|\bq-?o-?q\b/i.test(s) ? "qoq" : /growth$/.test(metric) ? "yoy" : null,
        basisNote: basisNote(s) ?? scoped, quote: s, speaker: t.speaker, page: pageOf(t, s),
      });
    });
  }
  return out;
}

/* ---------- evaluation ---------- */

export interface Actual {
  value: number;
  label: string;
  formula: string;
  source: PeriodFacts["source"];
  compareSource?: PeriodFacts["source"];
}

export interface Evaluation {
  status: GuidanceStatus;
  actual: Actual | null;
  variance: number | null; // percentage points beyond the guided band; 0 when inside it
  reason: string;
  range?: { low: number; high: number; basisTested: string }; // actuals across definitions, when more than one applies
}

const periodEndOf = (p: FiscalPeriod) => {
  if (p.kind === "FY") return `${p.fy}-03-31`;
  const q = p.q!;
  return q === 1 ? `${p.fy - 1}-06-30` : q === 2 ? `${p.fy - 1}-09-30` : q === 3 ? `${p.fy - 1}-12-31` : `${p.fy}-03-31`;
};

function actualFor(c: GuidanceClaim, end: string, cur: PeriodFacts, series: PeriodFacts[], withOtherIncome = false): Actual | { missing: string } {
  const label = fiscalLabel(end, cur.kind);
  switch (c.metric) {
    case "ebitda_margin": {
      const v = marginPct(cur.ebitda != null && withOtherIncome ? cur.ebitda + (cur.otherIncome ?? 0) : cur.ebitda, cur.revenue);
      if (withOtherIncome) return v == null ? { missing: "" } : { value: v, label, formula: "EBITDA including other income ÷ revenue from operations", source: cur.source };
      return v == null ? { missing: "EBITDA margin cannot be derived from the filing." } : { value: v, label, formula: "EBITDA (derived) ÷ revenue from operations", source: cur.source };
    }
    case "ebit_margin": {
      const v = marginPct(cur.ebit, cur.revenue);
      return v == null ? { missing: "EBIT margin cannot be derived from the filing." } : { value: v, label, formula: "EBIT (derived) ÷ revenue from operations", source: cur.source };
    }
    case "pat_margin": {
      const v = marginPct(cur.pat, cur.revenue);
      return v == null ? { missing: "PAT margin cannot be derived from the filing." } : { value: v, label, formula: "PAT ÷ revenue from operations", source: cur.source };
    }
    case "revenue_abs":
      return cur.revenue == null ? { missing: "Revenue is not in the filing." } : { value: cur.revenue, label, formula: `${cur.revenueLabel}, ${label}`, source: cur.source };
    case "revenue_growth":
    case "ebitda_growth":
    case "pat_growth": {
      const key = c.metric === "revenue_growth" ? "revenue" : c.metric === "ebitda_growth" ? "ebitda" : "pat";
      const baseEnd = c.comparison === "qoq" && cur.kind === "Q" ? priorQuarterEnd(end) : yearAgoEnd(end);
      const base = series.find((p) => p.periodEnd === baseEnd && p.kind === cur.kind);
      if (!base) return { missing: `Comparison period ${fiscalLabel(baseEnd, cur.kind)} is not in the filed series.` };
      const v = pctChange(cur[key], base[key]);
      return v == null ? { missing: `${key} growth cannot be computed from the filing.` } : { value: v, label, formula: `${label} vs ${base.label}, ${key}`, source: cur.source, compareSource: base.source };
    }
    default:
      return { missing: "No filed metric maps to this statement." };
  }
}

/** Status is only ever assigned by this function, from filed numbers. */
export function evaluateClaim(c: GuidanceClaim, series: PeriodFacts[], latestEnd: string | null): Evaluation {
  const none = (reason: string, status: GuidanceStatus = "insufficient"): Evaluation => ({ status, actual: null, variance: null, reason });
  if (c.low == null) return none("No numeric target in the statement.");
  if (c.unit === "INR" && c.metric !== "revenue_abs") return none("Guided in rupees; no filed figure maps to it.");
  if (c.unit === "%" && c.metric === "revenue_abs") return none("Unit does not match the metric.");
  if (!c.period) return none("Statement does not name a period.");
  if (c.basisNote) return none(c.basisNote);
  if (c.metric === "other" || c.metric === "capex") return none("No filed metric maps to this statement.");
  const end = periodEndOf(c.period);
  if (latestEnd && end > latestEnd) return none(`Period has not been reported yet (latest filed: ${fiscalLabel(latestEnd, "Q")}).`, "not_yet");
  const cur = series.find((p) => p.periodEnd === end && p.kind === c.period!.kind);
  if (!cur) return none("That period is not in the filed series.");
  const a = actualFor(c, end, cur, series);
  if ("missing" in a) return none(a.missing);
  const hi = c.high;
  // A point estimate gets half a point (or 2% of a rupee target) either way; ranges and floors get none.
  const tolerance = c.floor || (hi != null && hi !== c.low) ? 0 : c.unit === "INR" ? c.low * 0.02 : 0.5;
  if (c.metric === "revenue_abs" && (a.value < c.low * 0.5 || a.value > c.low * 2)) {
    // A target far from company-level revenue is about a product or plant, however it was phrased.
    return none("Target is out of scale with company revenue, so it is likely about one business line.");
  }
  if (a.value < c.low - tolerance) return { status: "missed", actual: a, variance: round(a.value - c.low), reason: "Below the guided level." };
  if (hi != null && a.value > hi + tolerance) return { status: "exceeded", actual: a, variance: round(a.value - hi), reason: "Above the guided level." };
  return { status: "met", actual: a, variance: 0, reason: c.floor ? "At or above the guided floor." : "Within the guided level." };
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Companies define EBITDA differently and report on two bases. A verdict is given only if it holds across every
 * definition the filings support; otherwise the range is shown and no verdict is given.
 */
export function evaluateRobust(c: GuidanceClaim, primary: PeriodFacts[], other: PeriodFacts[] | null, latestEnd: string | null): Evaluation {
  const base = evaluateClaim(c, primary, latestEnd);
  if (!base.actual || !c.period) return base;
  const end = periodEndOf(c.period);
  const variants: { value: number; note: string }[] = [{ value: base.actual.value, note: "" }];
  for (const series of other ? [primary, other] : [primary]) {
    const cur = series.find((p) => p.periodEnd === end && p.kind === c.period!.kind);
    if (!cur) continue;
    if (series !== primary) {
      const a = actualFor(c, end, cur, series);
      if (!("missing" in a)) variants.push({ value: a.value, note: "other basis" });
    }
    if (c.metric === "ebitda_margin") {
      const a = actualFor(c, end, cur, series, true);
      if (!("missing" in a)) variants.push({ value: a.value, note: "incl. other income" });
    }
  }
  const values = variants.map((v) => v.value);
  const low = Math.min(...values), high = Math.max(...values);
  const range = { low, high, basisTested: other ? "both bases" : "the filed basis" };
  const verdicts = new Set(values.map((v) => verdictOf(c, v)));
  if (verdicts.size > 1) {
    return {
      status: "insufficient", actual: base.actual, variance: null, range,
      reason: `Depends on the definition: ${low}% to ${high}% across ${range.basisTested}, with and without other income. FINN gives no verdict.`,
    };
  }
  return { ...base, range: low !== high ? range : undefined };
}

function verdictOf(c: GuidanceClaim, value: number): GuidanceStatus {
  const hi = c.high;
  const tolerance = c.floor || (hi != null && hi !== c.low) ? 0 : c.unit === "INR" ? c.low! * 0.02 : 0.5;
  if (value < c.low! - tolerance) return "missed";
  if (hi != null && value > hi + tolerance) return "exceeded";
  return "met";
}
