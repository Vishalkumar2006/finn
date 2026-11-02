import { checkAnswer, type ModelAnswer } from "./answerCheck";
import { parsePeriod } from "./guidance";
import type { Basis, FiscalPeriod, GuidanceMetric, GuidanceStatus, SourceRef } from "./types";

/**
 * Joins what management said to what was filed, for one question. Every value and verdict comes from a ledger row
 * built by guidance.ts. This file only selects rows and may lower one to "not tested"; it never assigns a verdict.
 */

export interface OutcomeRow {
  claim: {
    metric: GuidanceMetric; low: number | null; high: number | null; unit: "%" | "INR" | null; floor: boolean;
    period: FiscalPeriod | null; periodText: string | null; periodInferred: boolean; comparison: "yoy" | "qoq" | null;
    basisNote: string | null; quote: string; speaker: string; page: number;
  };
  evaluation: {
    status: GuidanceStatus; variance: number | null; reason: string;
    actual: { value: number; label: string; formula: string; source: SourceRef; compareSource?: SourceRef } | null;
    range?: { low: number; high: number; basisTested: string };
  };
  source: SourceRef;
  callLabel: string;
}

export interface OutcomeItem<R extends OutcomeRow = OutcomeRow> {
  row: R;
  scope: "group" | "consolidated" | "standalone" | null; // only when the statement itself says so
  alsoSaid: { callLabel: string; source: SourceRef }[]; // the same target repeated on other calls
}

export interface Outcome<R extends OutcomeRow = OutcomeRow> {
  basis: Basis;
  items: OutcomeItem<R>[];
  notTested: R[];
  summary: string[];
  explanation?: { lines: string[]; citations: SourceRef[]; model: string };
  explanationNote?: string;
  transcripts: string[];
  seeded: boolean;
}

export interface OutcomeIntent {
  metrics: GuidanceMetric[] | null; // null: the question names no metric, so any
  term: RegExp | null; // finds untestable statements on the same subject
  subject: string; // used when nothing matches
  period: FiscalPeriod | null;
}

/* ---------- which questions ---------- */

const PROMISE = /\b(guidance|guided?|guiding|targets?|promise[ds]?|promising|commitments?|committed|forecasts?|expectations?|outlook|aspirations?|projections?)\b/i;
const RESULT = /\b(meets?|met|meeting|miss(ed|es)?|achiev\w*|deliver\w*|beat|exceed\w*|f[ae]ll(s|ing)? short|hit|happened|track record|compare[ds]?|comparison|versus|vs\.?|against|actuals?|reported|results?|realistic|credib\w*|live[ds]? up|follow(ed)? through|outcomes?)\b/i;
const SAID_DID = /\b(said|say|saying|told|promised)\b.*\b(deliver\w*|happened|actual\w*|reported|results?|achiev\w*)\b/i;

const SUBJECTS: { term: RegExp; metrics: GuidanceMetric[] | null; subject: string }[] = [
  // Checked first: "sales volume" and "order inflow" are not revenue, and no filed figure maps to them.
  { term: /\b(aum|assets under management|loan (book|growth)|advances|disbursements?|deposits?|volumes?|tonnage|order (inflows?|book)|orders|capacity|market share|nim|net interest margin|credit costs?|roe|roa|roce)\b/i, metrics: [], subject: "that measure" },
  { term: /\bcapex\b|capital expenditure/i, metrics: ["capex"], subject: "capex" },
  { term: /\bebit\s*margins?\b/i, metrics: ["ebit_margin"], subject: "EBIT margin" },
  { term: /\b(pat|net( profit)?)\s*margins?\b/i, metrics: ["pat_margin"], subject: "PAT margin" },
  { term: /\b(ebitda|operating)\s*margins?\b/i, metrics: ["ebitda_margin"], subject: "EBITDA margin" },
  { term: /\bmargins?\b/i, metrics: ["ebitda_margin", "ebit_margin", "pat_margin"], subject: "margins" },
  { term: /\bebitda\b/i, metrics: ["ebitda_growth", "ebitda_margin"], subject: "EBITDA" },
  { term: /\b(pat|net profit|profit|bottom ?line|earnings growth)\b/i, metrics: ["pat_growth", "pat_margin"], subject: "profit" },
  { term: /\b(revenues?|sales|top ?line|turnover)\b/i, metrics: ["revenue_growth", "revenue_abs"], subject: "revenue" },
];

// "net zero target" or "hiring target" has its own subject, so it is left to document search.
const PLAIN_OWNER = /^(its|their|the|our|own|overall|financial|stated|any|earlier|previous|past|management|company|guidance|what|did|has|have|and|of|for|on)$|['’]s$|['’]$/i;

/** Null means this is an ordinary document question, which then never touches the ledger. */
export function outcomeIntent(question: string, today: string): OutcomeIntent | null {
  const q = question.trim();
  const asks = (PROMISE.test(q) && RESULT.test(q)) || SAID_DID.test(q);
  if (!asks) return null;
  const hit = SUBJECTS.find((s) => s.term.test(q));
  if (!hit) {
    const word = q.match(PROMISE);
    const before = word ? q.slice(0, word.index).trim().split(/\s+/).at(-1) ?? "" : "";
    if (word && before && !PLAIN_OWNER.test(before)) return null;
  }
  const { period } = parsePeriod(q, today);
  // Only the word asked about, so an AUM question doesn't collect ROE statements from the same list.
  const asked = hit && q.match(hit.term)?.[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const term = hit?.metrics?.length ? hit.term : asked ? new RegExp(`\\b${asked}\\b`, "i") : null;
  return { metrics: hit?.metrics ?? null, term, subject: hit ? (hit.metrics?.length ? hit.subject : asked!) : "any measure", period };
}

// "What about FY27?" or "And margins?" right after a guidance question. Anything longer is treated as a new question.
const FOLLOW_UP = /^\s*(and\s+)?((what|how)\s+about|and|for|in)\b/i;

/** A short follow-up keeps the previous guidance question and changes only the period or subject it names. */
export function followUpIntent(question: string, previous: string | undefined, today: string): OutcomeIntent | null {
  if (!previous || question.length > 60 || !FOLLOW_UP.test(question)) return null;
  const before = outcomeIntent(previous, today);
  if (!before) return null;
  const { period } = parsePeriod(question, today);
  const hit = SUBJECTS.find((s) => s.term.test(question));
  if (!period && !hit) return null;
  const subject = hit ? outcomeIntent(`Did management meet its ${question.match(hit.term)![0]} guidance?`, today) : null;
  return { ...before, ...(subject ? { metrics: subject.metrics, term: subject.term, subject: subject.subject } : {}), period: period ?? before.period };
}

/* ---------- which statements ---------- */

function samePeriod(asked: FiscalPeriod | null, p: FiscalPeriod | null): boolean {
  if (!asked) return true;
  if (!p || p.fy !== asked.fy) return false;
  return asked.kind === "FY" || (p.kind === "Q" && p.q === asked.q);
}

// A rupee target is only shown to be company-wide by the scale check against filed revenue, which needs a filed period.
const hasTarget = (r: OutcomeRow) => (r.evaluation.status === "not_yet" ? r.claim.metric !== "revenue_abs" : r.evaluation.status !== "insufficient" || r.evaluation.range != null);
const RANK: Record<GuidanceStatus, number> = { missed: 0, exceeded: 0, met: 0, insufficient: 1, not_yet: 2 };

function statedScope(quote: string): OutcomeItem["scope"] {
  if (/\bstandalone\b/i.test(quote)) return "standalone";
  if (/\bconsolidated\b/i.test(quote)) return "consolidated";
  return /\b(group|l&t group|the company as a whole)\b/i.test(quote) ? "group" : null;
}

/** A statement on one basis can't be scored on the other, whatever the numbers say. */
function basisConflict(scope: OutcomeItem["scope"], basis: Basis): boolean {
  return (scope === "standalone" && basis === "consolidated") || (scope === "consolidated" && basis === "standalone");
}

const callOf = (r: OutcomeRow) => r.source.filedAt ?? "";

const pct = (n: number) => `${n}%`;
const cr = (n: number) => `₹${Math.round(n / 1e7).toLocaleString("en-IN")} Cr`;
const METRIC_WORDS: Record<GuidanceMetric, string> = {
  revenue_growth: "revenue growth", revenue_abs: "revenue", ebitda_growth: "EBITDA growth", pat_growth: "PAT growth",
  ebitda_margin: "EBITDA margin", ebit_margin: "EBIT margin", pat_margin: "PAT margin", capex: "capex", other: "other",
};

function guided(c: OutcomeRow["claim"]): string {
  const f = c.unit === "INR" ? cr : pct;
  if (c.low == null) return "no number";
  if (c.floor) return `at least ${f(c.low)}`;
  return c.high != null && c.high !== c.low ? `${f(c.low)} to ${f(c.high)}` : f(c.low);
}

const periodName = (p: FiscalPeriod | null) => (!p ? "" : p.kind === "FY" ? `FY${String(p.fy).slice(-2)}` : `Q${p.q} FY${String(p.fy).slice(-2)}`);

/** Plain statement of one row. The only place verdict words are written, and they follow the row's own status. */
export function describe(item: OutcomeItem, basis: Basis): string {
  const { claim: c, evaluation: e } = item.row;
  // The label is the month the transcript was listed, which can be weeks after the call itself.
  const said = `In the call transcript listed for ${item.row.callLabel}, management guided ${guided(c)} ${METRIC_WORDS[c.metric]} for ${periodName(c.period)}.`;
  if (e.status === "not_yet") return `${said} That period has not been reported yet, so there is no verdict.`;
  if (!e.actual) return `${said} ${e.reason}`;
  const money = c.metric === "revenue_abs";
  if (e.status === "insufficient" && e.range) return `${said} Filed figures give ${e.range.low}% to ${e.range.high}% depending on the definition and basis, and the verdict changes across them, so FINN gives none.`;
  const value = money ? cr(e.actual.value) : `${e.actual.value}%`;
  const filed = `The ${basis} filing for ${e.actual.label} shows ${value}`;
  const gap = e.variance ? (money ? cr(Math.abs(e.variance)) : `${Math.abs(e.variance)} points`) : "";
  if (e.status === "missed") return `${said} ${filed}, ${gap} below it: missed.`;
  if (e.status === "exceeded") return `${said} ${filed}, ${gap} above it: exceeded.`;
  return `${said} ${filed}: met.`;
}

export function buildOutcome<R extends OutcomeRow>(rows: R[], basis: Basis, intent: OutcomeIntent): Pick<Outcome<R>, "items" | "notTested" | "summary" | "basis"> {
  const about = rows.filter((r) => {
    if (!samePeriod(intent.period, r.claim.period)) return false;
    if (!intent.metrics) return true;
    return intent.metrics.includes(r.claim.metric) || ((r.claim.metric === "other" || r.claim.metric === "capex") && Boolean(intent.term?.test(r.claim.quote)));
  });
  const testable: R[] = [];
  const notTested: R[] = [];
  for (const r of about) {
    const conflict = basisConflict(statedScope(r.claim.quote), basis);
    if (conflict) notTested.push({ ...r, evaluation: { status: "insufficient", actual: null, variance: null, reason: `The statement is on a ${statedScope(r.claim.quote)} basis, and the filing compared here is ${basis}.` } } as R);
    else (hasTarget(r) ? testable : notTested).push(r);
  }
  // One target repeated across calls is one promise with a history, shown from its latest statement.
  const groups = new Map<string, R[]>();
  for (const r of testable) {
    const key = [r.claim.metric, periodName(r.claim.period), r.claim.low, r.claim.high, r.evaluation.status].join("|");
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const items: OutcomeItem<R>[] = [...groups.values()]
    .map((g) => {
      const [lead, ...rest] = [...g].sort((a, b) => callOf(b).localeCompare(callOf(a)));
      return { row: lead, scope: statedScope(lead.claim.quote), alsoSaid: rest.map((r) => ({ callLabel: r.callLabel, source: r.source })) };
    })
    .sort((a, b) => RANK[a.row.evaluation.status] - RANK[b.row.evaluation.status] || callOf(b.row).localeCompare(callOf(a.row)))
    .slice(0, 3);
  const summary = items.map((i) => describe(i, basis));
  if (!items.length) {
    const when = intent.period ? ` for ${periodName(intent.period)}` : "";
    summary.push(notTested.length
      ? `FINN found statements on ${intent.subject}${when}, but none can be compared with a filed figure, so there is no verdict.`
      : `FINN found no management statement on ${intent.subject}${when} that it could extract from the calls it read, so there is no comparison to make.`);
  }
  return { basis, items, notTested: notTested.slice(0, 6), summary };
}

/* ---------- the model's explanation ---------- */

/** The block the model reads. Passed as evidence, so it can't state a figure that isn't here or in a transcript. */
export function factsPassage(item: OutcomeItem, basis: Basis): string {
  return `${describe(item, basis)} Statement: "${item.row.claim.quote}"`;
}

// The card carries the verdict. Any verdict in the model's own words is refused, even a correct one.
const OWN_VERDICT = /\b(miss(ed|es|ing)?|exceed(ed|s)|beat|fell short|falls? short|short of|under-?deliver\w*|over-?deliver\w*|fail(ed|s)?|met|did not meet|delivered|achieved|surpass\w*|outperform\w*|underperform\w*|(above|below|ahead of|behind) (its |the |their )?(guidance|target|expectation)s?)\b/i;
const ADVICE = /\b(buy|sell|hold|accumulate|overweight|underweight|undervalued|overvalued|price target|invest in)\b/i;
// The checks can't read meaning, so a causal link must be the source's own words, not the model's inference.
const CAUSAL = /\b(supported by|underpinned by|driven by|backed by|attributed|attributing|thanks to|because of|as a result of|owing to|due to|depended on|depends on|dependent on|contingent (?:up)?on|led to|resulted in)\b/i;
const REPORTING = /\b(reported|filed|actual(ly)?|grew|rose|increased|came in|ended|recorded|posted)\b/i;

/** A claim of a reported figure that repeats the guided number instead of the filed one contradicts the card. */
function misstatesResult(text: string, items: OutcomeItem[]): boolean {
  if (!REPORTING.test(text)) return false;
  const said = new Set((text.match(/\d+(?:\.\d+)?(?=\s*%)/g) ?? []).map(Number));
  return items.some((i) => {
    const { low, high, unit } = i.row.claim;
    const actual = i.row.evaluation.actual?.value;
    if (unit !== "%" || actual == null || said.has(actual) || i.row.evaluation.range) return false;
    return (low != null && said.has(low)) || (high != null && said.has(high));
  });
}

export type ExplanationCheck = { ok: true; claims: { text: string; citations: number[] }[] } | { ok: false; reason: string };

/**
 * All or nothing: an explanation that disputes the card can't be trusted by removing the sentence that showed it.
 * The first factCount passages are verified results. A filing can't support what management said, so a claim that
 * also cites a transcript has to stand on the transcript alone.
 */
export function checkExplanation(a: ModelAnswer, passages: string[], items: OutcomeItem[], factCount = 0): ExplanationCheck {
  if (a.status === "abstain") return { ok: false, reason: "the passages do not explain it" };
  for (const c of a.claims) {
    if (OWN_VERDICT.test(c.text)) return { ok: false, reason: "it stated a verdict of its own" };
    if (ADVICE.test(c.text)) return { ok: false, reason: "it gave investment advice" };
    if (misstatesResult(c.text, items)) return { ok: false, reason: "it contradicted a filed figure" };
  }
  const claims = a.claims.map((c) => {
    const spoken = c.citations.filter((n) => n > factCount);
    return { ...c, citations: spoken.length ? spoken : c.citations };
  });
  // Real case: "the margin target was supported by price increases", from a transcript that said "But overall" between them.
  for (const c of claims) {
    const link = c.text.match(CAUSAL)?.[0];
    if (link && !c.citations.some((n) => passages[n - 1]?.toLowerCase().includes(link.toLowerCase()))) return { ok: false, reason: `it linked cause and effect ("${link}") beyond its source` };
  }
  const r = checkAnswer({ ...a, claims }, passages);
  if (!r.ok) return { ok: false, reason: r.reason };
  if (r.status !== "answered" || r.removed) return { ok: false, reason: r.status === "answered" ? (r.firstProblem ?? "a claim failed its checks") : "the passages do not explain it" };
  return { ok: true, claims: r.claims };
}
