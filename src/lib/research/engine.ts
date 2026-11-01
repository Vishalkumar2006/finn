import { evaluateClaim, extractClaims, splitSentences, type Evaluation } from "../domain/guidance";
import { marginPct, pctChange, priorQuarterEnd, ratio, yearAgoEnd } from "../domain/metrics";
import { chunkPages, search, supported, tokenize, unverifiedNumbers, type Hit } from "../domain/retrieval";
import type { Basis, GuidanceClaim, PeriodFacts, SourceRef } from "../domain/types";
import { cached, mapLimit, SourceError } from "../sources/http";
import { fetchAnnouncements, fetchAnnualReports, fetchIntegratedResults, fetchLegacyResults, type ResultFiling } from "../sources/nse";
import { loadPdf } from "../sources/pdf";
import { fetchDocumentIndex, searchScreener } from "../sources/screener";
import { classifyEntity, parseResults } from "../sources/xbrl";
import { fetchHistory, searchYahoo } from "../sources/yahoo";
import { get } from "../sources/http";
import { complete, llmEnabled } from "./llm";

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
}

const MONTHS = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ");

function monthToIso(label: string): string | null {
  const m = label.match(/([A-Za-z]{3})\s+(\d{4})/);
  if (!m) return null;
  const i = MONTHS.indexOf(m[1].toLowerCase());
  return i < 0 ? null : `${m[2]}-${String(i + 1).padStart(2, "0")}-15`;
}

export async function getDocuments(symbol: string): Promise<{ docs: ResearchDoc[]; fetchedAt: string; stale: boolean; discovery: string }> {
  const r = await cached(`docs:${symbol}`, 12 * HOUR, async () => {
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
          if (iso && taken.some((m) => Math.abs(m - monthIndex(iso)) <= 1)) return;
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

export async function getLedger(symbol: string, quarters = 6): Promise<Ledger> {
  const [{ docs }, fin] = await Promise.all([getDocuments(symbol), getFinancials(symbol)]);
  const transcripts = docs.filter((d) => d.kind === "transcript" && d.callDate).slice(0, quarters);
  const series = [...fin.quarters, ...fin.years];
  const latestEnd = fin.quarters[0]?.periodEnd ?? null;
  const read = await mapLimit(transcripts, 3, async (d) => {
    try {
      const pdf = await loadPdf(d.url, 60);
      if (pdf.value.scanned) return { d, pages: pdf.value.pageCount, claims: [] as GuidanceClaim[], error: "Scanned PDF with no text layer" };
      if (pdf.value.pageCount < 4) return { d, pages: pdf.value.pageCount, claims: [] as GuidanceClaim[], error: "Link or notice, not a full transcript" };
      return { d, pages: pdf.value.pageCount, claims: extractClaims(pdf.value.pages, d.callDate!) };
    } catch (e) {
      return { d, pages: 0, claims: [] as GuidanceClaim[], error: e instanceof Error ? e.message : "Could not read" };
    }
  });
  const rows: LedgerRow[] = [];
  for (const r of read) {
    for (const claim of r.claims) {
      rows.push({
        claim, evaluation: evaluateClaim(claim, series, latestEnd), callLabel: r.d.label,
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
    note: "Statements found by rule-based extraction from transcripts. Verdicts are computed only from filed XBRL numbers.",
  };
}

/* ---------- retrieval and questions ---------- */

async function corpus(symbol: string, opts: { transcripts?: number; ar?: boolean } = {}) {
  const { docs } = await getDocuments(symbol);
  const tr = docs.filter((d) => d.kind === "transcript").slice(0, opts.transcripts ?? 4);
  const ar = opts.ar === false ? [] : docs.filter((d) => d.kind === "annual_report").slice(0, 1);
  const parsed = await mapLimit([...tr, ...ar], 3, async (d) => {
    try {
      const pdf = await loadPdf(d.url, d.kind === "annual_report" ? 160 : 60);
      return { d, pages: pdf.value.pages, pageCount: pdf.value.pageCount, scanned: pdf.value.scanned };
    } catch (e) {
      return { d, pages: [] as string[], pageCount: 0, scanned: false, error: e instanceof Error ? e.message : "Could not read" };
    }
  });
  return parsed;
}

function toCitation(h: Hit, d: ResearchDoc): SourceRef {
  return {
    url: d.url, title: d.kind === "transcript" ? `Earnings call transcript, ${d.label}` : `Annual report, ${d.label}`,
    docType: d.kind, page: h.page, excerpt: bestExcerpt(h.text),
  };
}

function bestExcerpt(text: string): string {
  return text.length > 700 ? `${text.slice(0, 700).replace(/\s+\S*$/, "")}…` : text;
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
}

export async function ask(symbol: string, question: string, previous?: string): Promise<Answer> {
  const docs = await corpus(symbol);
  const coverage = docs.map((d) =>
    d.pages.length ? `${d.d.label} ${d.d.kind === "transcript" ? "transcript" : "annual report"}: ${d.pages.length} of ${d.pageCount} pages searched`
      : `${d.d.label}: not readable (${"error" in d ? d.error : d.scanned ? "scanned" : "empty"})`);
  const byId = new Map(docs.map((d) => [d.d.id, d.d]));
  const chunks = docs.flatMap((d) => chunkPages(d.d.id, d.pages));
  const query = previous ? `${question} ${previous}` : question;
  const hits = search(chunks, query, 5);
  if (!supported(hits[0], question)) {
    return {
      mode: "abstain",
      answer: [chunks.length ? "The documents searched do not support an answer to this." : "No readable primary documents were found for this company."],
      citations: [], coverage,
    };
  }
  const citations = hits.map((h) => toCitation(h, byId.get(h.docId)!));
  if (llmEnabled()) {
    const passages = hits.map((h, i) => `<passage id="${i + 1}" source="${citations[i].title}, page ${h.page}">\n${h.text}\n</passage>`).join("\n");
    const text = await complete(`${passages}\n\nQuestion: ${question}`);
    if (text) {
      const bad = unverifiedNumbers(text, hits.map((h) => h.text).join(" "));
      const cited = [...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
      if (!bad.length && cited.length && cited.every((n) => n >= 1 && n <= hits.length)) {
        return { mode: "llm", answer: [text], citations, coverage };
      }
      return { mode: "extractive", answer: extractive(hits, citations, question), citations, coverage, llmRejected: bad.length ? `Model answer rejected: ${bad.join(", ")} not in sources.` : "Model answer rejected: citations missing." };
    }
  }
  return { mode: "extractive", answer: extractive(hits, citations, question), citations, coverage };
}

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
    if (r.evaluation.status === "missed" && r.evaluation.actual) pts.push({ side: "bear", text: `Missed guidance from the ${r.callLabel} call: ${r.evaluation.actual.value}% against ${r.claim.low}% for ${r.claim.periodText}.`, source: r.source });
    if ((r.evaluation.status === "met" || r.evaluation.status === "exceeded") && r.evaluation.actual) pts.push({ side: "bull", text: `Delivered on guidance from the ${r.callLabel} call: ${r.evaluation.actual.value}% against ${r.claim.low}% for ${r.claim.periodText}.`, source: r.source });
  }
  return pts;
}
