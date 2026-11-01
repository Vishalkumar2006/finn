import { evaluateRobust, extractClaims, managementPages, splitSentences, type Evaluation } from "../domain/guidance";
import { marginPct, pctChange, priorQuarterEnd, ratio, yearAgoEnd } from "../domain/metrics";
import { checkAnswer, parseModelAnswer, renumber, sanitisePassage } from "../domain/answerCheck";
import { chunkPages, dropBoilerplate, search, supported, tokenize, type Hit } from "../domain/retrieval";
import type { Basis, GuidanceClaim, PeriodFacts, SourceRef } from "../domain/types";
import { cached, mapLimit, SourceError } from "../sources/http";
import { fetchAnnouncements, fetchAnnualReports, fetchIntegratedResults, fetchLegacyResults, type ResultFiling } from "../sources/nse";
import { loadPdf } from "../sources/pdf";
import { fetchDocumentIndex, searchScreener } from "../sources/screener";
import { classifyEntity, parseResults } from "../sources/xbrl";
import { fetchHistory, searchYahoo } from "../sources/yahoo";
import { get } from "../sources/http";
import { allowLlmCall } from "./guard";
import { complete, llmEnabled, llmModelName, promptVersion } from "./llm";

const HOUR = 3600e3;
const DAY = 24 * HOUR;

/* ---------- company resolution ---------- */

export interface CompanyMatch {
  symbol: string;
  name: string;
}

export async function resolveCompany(q: string): Promise<{ matches: CompanyMatch[]; degraded: boolean }> {
  const query = q.trim();
  if (query.length < 2 || query.length > 60) return { matches: [], degraded: false };
  const [sc, ya] = await Promise.allSettled([searchScreener(query), searchYahoo(query)]);
  const seen = new Map<string, string>();
  if (sc.status === "fulfilled") for (const m of sc.value) seen.set(m.symbol, m.name);
  if (ya.status === "fulfilled") for (const m of ya.value) if (!seen.has(m.symbol)) seen.set(m.symbol, m.name);
  const upper = query.toUpperCase();
  const candidates = [...seen.entries()].slice(0, 6).map(([symbol, name]) => ({ symbol, name }));
  // An exact symbol goes first; a symbol neither index knows gets one direct try against prices.
  candidates.sort((a, b) => Number(b.symbol === upper) - Number(a.symbol === upper));
  if (!seen.has(upper) && /^[A-Z0-9&-]+$/.test(upper)) {
    try {
      const h = await fetchHistory(upper, "5d");
      if (h.bars.length) candidates.unshift({ symbol: upper, name: upper });
    } catch {
      // Not a valid NSE symbol; the name matches above still stand.
    }
  }
  return { matches: candidates, degraded: sc.status === "rejected" || ya.status === "rejected" };
}

/* ---------- filed financials ---------- */

export interface Financials {
  symbol: string;
  basis: Basis;
  availableBases: Basis[];
  entityClass: PeriodFacts["entityClass"];
  quarters: PeriodFacts[];
  years: PeriodFacts[];
  fetchedAt: string;
  stale: boolean;
  coverageNote: string | null;
}

async function loadFacts(f: ResultFiling, industry?: string): Promise<PeriodFacts[]> {
  const r = await cached(`xbrl:${f.xbrl}`, 365 * DAY, async () => {
    const res = await get(f.xbrl, { source: "nse" });
    return parseResults(await res.text(), { url: f.xbrl, filedAt: f.filedAt, audited: f.audited, entityClass: classifyEntity(f.xbrl, industry) });
  });
  return r.value;
}

async function industryOf(symbol: string): Promise<string | undefined> {
  const r = await cached(`industry:${symbol}`, 30 * DAY, async () => {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 120 * DAY).toISOString().slice(0, 10);
    const a = await fetchAnnouncements(from, to, symbol);
    return a.find((x) => x.industry)?.industry ?? "";
  }).catch(() => null);
  return r?.value || undefined;
}

export async function getFinancials(symbol: string, want?: Basis): Promise<Financials> {
  const list = await cached(`results-index:${symbol}`, 6 * HOUR, async () => {
    const [i, l] = await Promise.allSettled([fetchIntegratedResults(symbol), fetchLegacyResults(symbol)]);
    if (i.status === "rejected" && l.status === "rejected") throw i.reason;
    return [...(i.status === "fulfilled" ? i.value : []), ...(l.status === "fulfilled" ? l.value : [])];
  });
  const filings = list.value.sort((a, b) => b.periodEnd.localeCompare(a.periodEnd) || (b.filedAt ?? "").localeCompare(a.filedAt ?? ""));
  if (!filings.length) throw new SourceError("nse", 404, `No results filings found for ${symbol}`);

  const latest = filings[0].periodEnd;
  const hasCons = filings.some((f) => f.consolidated && f.periodEnd === latest) ;
  const availableBases: Basis[] = hasCons ? ["consolidated", "standalone"] : filings.some((f) => f.consolidated) ? ["standalone", "consolidated"] : ["standalone"];
  const basis: Basis = want && availableBases.includes(want) ? want : availableBases[0];

  // Newest filing per period wins, so revisions replace originals.
  const byPeriod = new Map<string, ResultFiling>();
  for (const f of filings) {
    if (f.consolidated !== (basis === "consolidated")) continue;
    if (!byPeriod.has(f.periodEnd)) byPeriod.set(f.periodEnd, f);
  }
  const ordered = [...byPeriod.values()];
  const recent = ordered.slice(0, 9);
  const marches = ordered.slice(9).filter((f) => f.periodEnd.endsWith("-03-31")).slice(0, 4);
  const industry = await industryOf(symbol);
  const parsed = await mapLimit([...recent, ...marches], 5, async (f) => {
    try {
      return { facts: await loadFacts(f, industry), wanted: recent.includes(f) };
    } catch {
      return { facts: [] as PeriodFacts[], wanted: recent.includes(f), failed: true };
    }
  });
  const q = new Map<string, PeriodFacts>();
  const y = new Map<string, PeriodFacts>();
  let failed = 0;
  for (const p of parsed) {
    if ((p as { failed?: boolean }).failed) failed++;
    for (const fact of p.facts) {
      if (fact.basis !== basis) continue;
      if (fact.kind === "Q" && p.wanted && !q.has(fact.periodEnd)) q.set(fact.periodEnd, fact);
      if (fact.kind === "FY" && !y.has(fact.periodEnd)) y.set(fact.periodEnd, fact);
    }
  }
  const quarters = [...q.values()].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
  const years = [...y.values()].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
  return {
    symbol, basis, availableBases, entityClass: quarters[0]?.entityClass ?? years[0]?.entityClass ?? "operating",
    quarters, years, fetchedAt: list.fetchedAt, stale: list.stale,
    coverageNote: failed ? `${failed} filing(s) could not be parsed and are omitted, not estimated.` : null,
  };
}

/* ---------- documents ---------- */

export interface ResearchDoc {
  id: string;
  kind: "transcript" | "annual_report";
  url: string;
  label: string;
  callDate: string | null;
  host: string;
  altUrl?: string; // another copy of the same call, tried if the first is only a link notice
}

const MONTHS = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ");

function monthToIso(label: string): string | null {
  const m = label.match(/([A-Za-z]{3})\s+(\d{4})/);
  if (!m) return null;
  const i = MONTHS.indexOf(m[1].toLowerCase());
  return i < 0 ? null : `${m[2]}-${String(i + 1).padStart(2, "0")}-15`;
}

export async function getDocuments(symbol: string): Promise<{ docs: ResearchDoc[]; fetchedAt: string; stale: boolean; discovery: string }> {
  const r = await cached(`docs2:${symbol}`, 12 * HOUR, async () => {
    const out: ResearchDoc[] = [];
    let discovery = "NSE annual reports and transcript filings; Screener for older transcripts";
    const ars = await fetchAnnualReports(symbol).catch(() => []);
    ars.forEach((a, i) => out.push({
      id: `R${i}`, kind: "annual_report", url: a.url, label: `FY${a.toYr.slice(-2)}`, callDate: null, host: new URL(a.url).host,
    }));
    // The exchange's own copy comes first: exact filing date, stable host.
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 500 * DAY).toISOString().slice(0, 10);
    const nseTr = (await fetchAnnouncements(from, to, symbol).catch(() => []))
      .filter((a) => a.url && /transcript/i.test(a.text) && !/audio|video/i.test(a.text));
    const months = new Set<string>();
    const monthIndex = (iso: string) => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7));
    const taken: number[] = [];
    nseTr.forEach((a, i) => {
      const callDate = a.at.slice(0, 10);
      if (taken.some((m) => Math.abs(m - monthIndex(callDate)) <= 1)) return;
      taken.push(monthIndex(callDate));
      const label = `${MONTHS[Number(callDate.slice(5, 7)) - 1].replace(/^./, (c) => c.toUpperCase())} ${callDate.slice(0, 4)}`;
      months.add(label);
      out.push({ id: `N${i}`, kind: "transcript", url: a.url!, label, callDate, host: new URL(a.url!).host });
    });
    try {
      const idx = await fetchDocumentIndex(symbol);
      idx.forEach((d, i) => {
        if (d.kind === "annual_report" && ars.length) return;
        if (d.kind === "transcript") {
          if (months.has(d.label)) return; // one call per month; Screener often lists a BSE and a company copy
          const iso = monthToIso(d.label);
          if (iso && taken.some((m) => Math.abs(m - monthIndex(iso)) <= 1)) {
            const twin = out.find((x) => x.kind === "transcript" && x.callDate && Math.abs(monthIndex(x.callDate) - monthIndex(iso)) <= 1);
            if (twin && !twin.altUrl) twin.altUrl = d.url;
            return;
          }
          months.add(d.label);
        }
        out.push({
          id: `${d.kind === "transcript" ? "T" : "A"}${i}`, kind: d.kind, url: d.url, label: d.label,
          callDate: d.kind === "transcript" ? monthToIso(d.label) : null, host: new URL(d.url).host,
        });
      });
    } catch {
      discovery = "NSE filings (Screener unavailable)";
    }
    // An empty list after a source failure must not be cached, or a brief outage would hide documents for 12 hours.
    if (!out.length) throw new SourceError("documents", 404, `No transcripts or annual reports found for ${symbol} right now.`);
    out.sort((a, b) => (b.callDate ?? "").localeCompare(a.callDate ?? ""));
    return { docs: out, discovery };
  });
  return { docs: r.value.docs, discovery: r.value.discovery, fetchedAt: r.fetchedAt, stale: r.stale };
}

/* ---------- management said vs delivered ---------- */

export interface LedgerRow {
  claim: GuidanceClaim;
  evaluation: Evaluation;
  source: SourceRef;
  callLabel: string;
}

export interface Ledger {
  symbol: string;
  basis: Basis;
  rows: LedgerRow[];
  counts: Record<string, number>;
  transcriptsRead: { label: string; url: string; pages: number; claims: number; error?: string }[];
  note: string;
}

const METRIC_RANK: Record<string, number> = { revenue_growth: 0, revenue_abs: 0, ebitda_growth: 1, pat_growth: 1, ebitda_margin: 1, ebit_margin: 1, pat_margin: 2, capex: 3, other: 4 };
const STATUS_RANK: Record<string, number> = { missed: 0, exceeded: 1, met: 2, not_yet: 3, insufficient: 4 };

/** Some companies file a one-page notice linking to the recording; only a real transcript counts. */
async function loadTranscript(d: ResearchDoc) {
  let lastError: unknown;
  for (const url of [d.url, d.altUrl].filter((u): u is string => Boolean(u))) {
    try {
      const pdf = await loadPdf(url, 60);
      if (!pdf.value.scanned && pdf.value.pageCount >= 4) return { ...pdf.value, url };
      lastError = new Error(pdf.value.scanned ? "Scanned PDF with no text layer" : "Link or notice, not a full transcript");
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

export async function getLedger(symbol: string, quarters = 6): Promise<Ledger> {
  const [{ docs }, fin] = await Promise.all([getDocuments(symbol), getFinancials(symbol)]);
  const transcripts = docs.filter((d) => d.kind === "transcript" && d.callDate).slice(0, quarters);
  const series = [...fin.quarters, ...fin.years];
  const otherBasis = fin.availableBases.find((b) => b !== fin.basis);
  const otherFin = otherBasis ? await getFinancials(symbol, otherBasis).catch(() => null) : null;
  const otherSeries = otherFin ? [...otherFin.quarters, ...otherFin.years] : null;
  const latestEnd = fin.quarters[0]?.periodEnd ?? null;
  const read = await mapLimit(transcripts, 3, async (d) => {
    try {
      const t = await loadTranscript(d);
      return { d: { ...d, url: t.url }, pages: t.pageCount, claims: extractClaims(t.pages, d.callDate!) };
    } catch (e) {
      return { d, pages: 0, claims: [] as GuidanceClaim[], error: e instanceof Error ? e.message : "Could not read" };
    }
  });
  const rows: LedgerRow[] = [];
  for (const r of read) {
    for (const claim of r.claims) {
      rows.push({
        claim, evaluation: evaluateRobust(claim, series, otherSeries, latestEnd), callLabel: r.d.label,
        source: { url: r.d.url, title: `Earnings call transcript, ${r.d.label}`, docType: "transcript", page: claim.page, excerpt: claim.quote, filedAt: r.d.callDate ?? undefined },
      });
    }
  }
  rows.sort((a, b) =>
    STATUS_RANK[a.evaluation.status] - STATUS_RANK[b.evaluation.status] ||
    Number(b.claim.low != null) - Number(a.claim.low != null) ||
    METRIC_RANK[a.claim.metric] - METRIC_RANK[b.claim.metric]);
  const top = rows.slice(0, 14);
  const counts: Record<string, number> = { exceeded: 0, met: 0, missed: 0, not_yet: 0, insufficient: 0 };
  for (const r of top) counts[r.evaluation.status]++;
  return {
    symbol, basis: fin.basis, rows: top, counts,
    transcriptsRead: read.map((r) => ({ label: r.d.label, url: r.d.url, pages: r.pages, claims: r.claims.length, error: r.error })),
    note: "Statements found by rule-based extraction from transcripts. Verdicts use filed XBRL numbers only, and must hold on every definition the filings support.",
  };
}

/* ---------- retrieval and questions ---------- */

/** Parsing continues in the background and is cached, so asking again can succeed. */
const within = <T,>(work: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([work, new Promise<T>((res) => setTimeout(() => res(fallback), ms))]);

// A cold server can need longer than this for a large annual report; answer from what is ready instead of failing.
const CORPUS_BUDGET_MS = 40000;

async function corpus(symbol: string, opts: { transcripts?: number; ar?: boolean } = {}) {
  const { docs } = await getDocuments(symbol);
  const tr = docs.filter((d) => d.kind === "transcript").slice(0, opts.transcripts ?? 4);
  const ar = opts.ar === false ? [] : docs.filter((d) => d.kind === "annual_report").slice(0, 1);
  const started = Date.now();
  const parsed = await Promise.all([...tr, ...ar].map(async (d) => {
    const late = { d, pages: [] as string[], pageCount: 0, scanned: false, error: "Not read in time; ask again to retry" };
    return within(readOne(d), Math.max(1000, CORPUS_BUDGET_MS - (Date.now() - started)), late);
  }));
  return parsed;

  async function readOne(d: ResearchDoc) {
    try {
      if (d.kind === "transcript") {
        const t = await loadTranscript(d);
        return { d: { ...d, url: t.url }, pages: t.pages, pageCount: t.pageCount, scanned: false };
      }
      const pdf = await loadPdf(d.url, 160);
      return { d, pages: pdf.value.pages, pageCount: pdf.value.pageCount, scanned: pdf.value.scanned };
    } catch (e) {
      return { d, pages: [] as string[], pageCount: 0, scanned: false, error: e instanceof Error ? e.message : "Could not read" };
    }
  }
}

function toCitation(h: Hit, d: ResearchDoc): SourceRef {
  return {
    url: d.url, title: d.kind === "transcript" ? `Earnings call transcript, ${d.label}` : `Annual report, ${d.label}`,
    docType: d.kind, page: h.page, excerpt: bestExcerpt(h.text),
  };
}

function bestExcerpt(text: string): string {
  return text.length > 1400 ? `${text.slice(0, 1400).replace(/\s+\S*$/, "")}…` : text;
}

/** The sentence of a passage that best matches the question. Quoted verbatim, never rewritten. */
function topSentence(text: string, query: string): string {
  const q = new Set(tokenize(query));
  let best = "", bestScore = -1;
  for (const s of splitSentences(text)) {
    if (s.length < 40 || s.length > 420 || s.endsWith("?")) continue;
    const score = tokenize(s).filter((t) => q.has(t)).length + (/\d/.test(s) ? 0.3 : 0);
    if (score > bestScore) { best = s; bestScore = score; }
  }
  return best || bestExcerpt(text).slice(0, 300);
}

export interface Answer {
  mode: "llm" | "extractive" | "abstain";
  answer: string[];
  citations: SourceRef[];
  coverage: string[];
  llmRejected?: string;
  model?: string;
}

/** Enough different documents for "how has this changed" to be answerable: best passages, no more than 3 per document. */
export function diversify(hits: Hit[], k = 8, perDoc = 3): Hit[] {
  const counts = new Map<string, number>();
  const out: Hit[] = [];
  for (const h of hits) {
    const n = counts.get(h.docId) ?? 0;
    if (n >= perDoc) continue;
    counts.set(h.docId, n + 1);
    out.push(h);
    if (out.length === k) break;
  }
  return out;
}

const REASON: Record<string, string> = {
  timeout: "The model did not respond in time.",
  provider: "The model is unavailable right now.",
  empty: "The model returned nothing usable.",
};

type LlmOutcome = Pick<Answer, "mode" | "answer" | "citations" | "model"> | { rejected: string };

/** Model output is only ever text over retrieved passages. Filed numbers and verdicts never pass through here. */
async function synthesize(question: string, previous: string | undefined, passages: Hit[], cites: SourceRef[]): Promise<LlmOutcome> {
  const blocks = passages.map((h, i) => {
    const meta = cites[i].title.replace(/[<>"]/g, "");
    return `<passage id="${i + 1}" source="${meta}, page ${h.page}">\n${sanitisePassage(h.text)}\n</passage>`;
  }).join("\n");
  const context = previous ? `Earlier question, for context only: ${previous.slice(0, 400)}\n` : "";
  const r = await complete(`${blocks}\n\n${context}Question: ${question}`);
  if (!r.ok) return { rejected: REASON[r.reason] ?? REASON.provider };
  const parsed = parseModelAnswer(r.text);
  if (!parsed) return { rejected: "The model's reply was malformed." };
  // The source label counts as evidence, so "the May 2026 call said" can pass.
  const checked = checkAnswer(parsed, passages.map((h, i) => `${cites[i].title}. ${h.text}`));
  if (!checked.ok) {
    console.error(`llm: answer rejected: ${checked.reason}`);
    return { rejected: `A model answer was rejected: ${checked.reason}.` };
  }
  const model = r.model;
  if (checked.status === "abstain") return { mode: "abstain", answer: [`The documents searched do not answer this. ${checked.reason}`], citations: [], model };
  const { lines, used } = renumber(checked.claims);
  return { mode: "llm", answer: lines, citations: used.map((n) => cites[n - 1]), model };
}

export async function ask(symbol: string, question: string, previous?: string): Promise<Answer> {
  let docs: Awaited<ReturnType<typeof corpus>>;
  try {
    docs = await corpus(symbol);
  } catch (e) {
    return { mode: "abstain", answer: [e instanceof Error ? e.message : "Documents could not be found."], citations: [], coverage: [] };
  }
  const coverage = docs.map((d) =>
    d.pages.length ? `${d.d.label} ${d.d.kind === "transcript" ? "transcript" : "annual report"}: ${d.pages.length} of ${d.pageCount} pages searched`
      : `${d.d.label}: not readable (${"error" in d ? d.error : d.scanned ? "scanned" : "empty"})`);
  const byId = new Map(docs.map((d) => [d.d.id, d.d]));
  const chunks = dropBoilerplate(docs.flatMap((d) => chunkPages(d.d.id, d.d.kind === "transcript" ? managementPages(d.pages) : d.pages)));
  // A follow-up stands alone if it can. Only a vague one ("why was that?") borrows the previous question's terms.
  let hits = search(chunks, question, 24);
  let query = question;
  if (previous && !supported(hits[0], question)) {
    query = `${question} ${previous}`;
    hits = search(chunks, query, 24);
  }
  const abstain = (llmRejected?: string): Answer => ({
    mode: "abstain",
    answer: [llmRejected && chunks.length ? "No passage matches closely enough to quote, and the model that could assess it did not give a usable answer. Try a more specific question." : chunks.length ? "The documents searched do not support an answer to this." : "No primary documents could be read for this company just now. Check what was searched below, then try again."],
    citations: [], coverage, llmRejected,
  });
  if (!hits.length) return abstain();
  const top = hits.slice(0, 5);
  const citations = top.map((h) => toCitation(h, byId.get(h.docId)!));
  // Quoting needs a close keyword match. A model can judge analytic questions, so the gate only applies without one.
  const fallback = (llmRejected?: string): Answer =>
    supported(hits[0], query) ? { mode: "extractive", answer: extractive(top, citations, query), citations, coverage, llmRejected } : abstain(llmRejected);
  if (!llmEnabled()) return fallback();
  if (!allowLlmCall()) return fallback("The daily model allowance is used up, so model answers are off for now.");

  const passages = diversify(hits);
  const cites = passages.map((h) => toCitation(h, byId.get(h.docId)!));
  // Only checked answers are cached. A failure is retried next time, and a repeat question costs nothing.
  const key = `ask:${promptVersion()}:${llmModelName()}:${symbol}:${query.toLowerCase().replace(/\s+/g, " ").trim()}:${passages.map((h) => `${h.docId}${h.page}`).join()}`;
  try {
    const c = await cached(key, 6 * HOUR, async () => {
      const out = await synthesize(question, previous, passages, cites);
      if ("rejected" in out) throw new LlmRejected(out.rejected);
      return out as Exclude<LlmOutcome, { rejected: string }>;
    });
    return { ...c.value, coverage };
  } catch (e) {
    return fallback(e instanceof LlmRejected ? e.message : REASON.provider);
  }
}

class LlmRejected extends Error {}

function extractive(hits: Hit[], _c: SourceRef[], question: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  hits.slice(0, 3).forEach((h, i) => {
    const s = topSentence(h.text, question);
    if (!seen.has(s)) {
      seen.add(s);
      out.push(`${s} [${i + 1}]`);
    }
  });
  return out;
}

/* ---------- business snapshot and bull/bear ---------- */

export interface Snapshot {
  business: { text: string; citation: SourceRef }[];
  coverage: string[];
}

export async function getBusiness(symbol: string): Promise<Snapshot> {
  const docs = await corpus(symbol, { transcripts: 1 });
  const ar = docs.filter((d) => d.d.kind === "annual_report" && d.pages.length);
  const use = ar.length ? ar : docs.filter((d) => d.pages.length);
  const query = "company overview principal business activities products services customers segments operates";
  const byId = new Map(use.map((d) => [d.d.id, d.d]));
  const hits = search(use.flatMap((d) => chunkPages(d.d.id, d.pages)), query, 4);
  const seen = new Set<string>();
  const business: Snapshot["business"] = [];
  for (const h of hits) {
    const text = topSentence(h.text, query);
    if (seen.has(text)) continue;
    seen.add(text);
    business.push({ text, citation: toCitation(h, byId.get(h.docId)!) });
    if (business.length === 3) break;
  }
  return { business, coverage: use.map((d) => `${d.d.label}: ${d.pages.length} of ${d.pageCount} pages searched`) };
}

export interface CasePoint {
  side: "bull" | "bear";
  text: string;
  source: SourceRef;
}

/** Rule-based: each point is a computed fact from filings or a guidance verdict. No model, no opinion. */
export function buildCase(fin: Financials, ledger: Ledger | null): CasePoint[] {
  const pts: CasePoint[] = [];
  const cur = fin.quarters[0];
  if (cur) {
    const ya = fin.quarters.find((p) => p.periodEnd === yearAgoEnd(cur.periodEnd));
    const rev = pctChange(cur.revenue, ya?.revenue);
    const pat = pctChange(cur.pat, ya?.pat);
    if (rev != null) pts.push({ side: rev >= 10 ? "bull" : rev < 5 ? "bear" : rev >= 5 ? "bull" : "bear", text: `${cur.revenueLabel} ${rev >= 0 ? "up" : "down"} ${Math.abs(rev)}% YoY in ${cur.label}.`, source: cur.source });
    if (pat != null) pts.push({ side: pat >= 0 ? "bull" : "bear", text: `PAT ${pat >= 0 ? "up" : "down"} ${Math.abs(pat)}% YoY in ${cur.label}.`, source: cur.source });
    if (ya && cur.ebitda != null && ya.ebitda != null) {
      const a = marginPct(cur.ebitda, cur.revenue), b = marginPct(ya.ebitda, ya.revenue);
      if (a != null && b != null) {
        const d = Math.round((a - b) * 100) / 100;
        if (Math.abs(d) >= 0.25) pts.push({ side: d > 0 ? "bull" : "bear", text: `EBITDA margin ${d > 0 ? "expanded" : "compressed"} ${Math.abs(d)} pts YoY to ${a}%.`, source: cur.source });
      }
    }
    const prev = fin.quarters.find((p) => p.periodEnd === priorQuarterEnd(cur.periodEnd));
    const qoq = pctChange(cur.revenue, prev?.revenue);
    if (qoq != null && qoq < 0) pts.push({ side: "bear", text: `${cur.revenueLabel} fell ${Math.abs(qoq)}% from ${prev!.label}.`, source: cur.source });
  }
  const fy = fin.years[0];
  if (fy && fy.cfo != null && fy.pat != null && fy.pat > 0) {
    const conv = ratio(fy.cfo, fy.pat)!;
    pts.push({ side: conv >= 0.8 ? "bull" : "bear", text: `${fy.label} operating cash flow was ${conv}× PAT.`, source: fy.source });
  }
  if (fy && fy.entityClass === "operating" && fy.borrowings != null && fy.equity != null && fy.equity > 0) {
    const de = ratio(fy.borrowings, fy.equity)!;
    pts.push({ side: de <= 0.5 ? "bull" : de >= 1 ? "bear" : "bull", text: `Debt-to-equity ${de}× at ${fy.label} year-end.`, source: fy.source });
  }
  for (const r of ledger?.rows ?? []) {
    const a = r.evaluation.actual;
    if (!a) continue;
    const said = r.claim.high != null && r.claim.high !== r.claim.low ? `${r.claim.low}% to ${r.claim.high}%` : `${r.claim.low}%`;
    if (r.claim.unit !== "%") continue;
    if (r.evaluation.status === "missed") pts.push({ side: "bear", text: `Missed guidance from the ${r.callLabel} call: ${a.value}% against ${said} for ${a.label}.`, source: r.source });
    if (r.evaluation.status === "met" || r.evaluation.status === "exceeded") pts.push({ side: "bull", text: `Delivered on guidance from the ${r.callLabel} call: ${a.value}% against ${said} for ${a.label}.`, source: r.source });
  }
  return pts;
}
