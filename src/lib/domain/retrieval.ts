/** BM25 over page-level chunks. Lexical search fits filings well: investors ask about named metrics and terms. */

export interface Chunk {
  docId: string;
  page: number;
  text: string;
}

export interface Hit extends Chunk {
  score: number;
}

const STOP = new Set("a an and are as at be been but by can could did do does for from had has have how i if in into is it its of on or our so than that the their them there these they this to was we were what when where which who why will with would you your about company management tell me give please evidence support supports contradict contradicts recent between said saying say".split(" "));

const SYNONYMS: Record<string, string[]> = {
  revenue: ["sales", "topline", "income"], sales: ["revenue", "topline"],
  profit: ["pat", "ebitda", "earnings"], margin: ["margins", "ebitda", "profitability"], margins: ["margin", "ebitda"],
  debt: ["borrowings", "leverage", "debt-equity"], capex: ["capital", "expenditure", "capacity"],
  guidance: ["expect", "outlook", "target", "guide"], outlook: ["expect", "guidance", "forward", "visibility"], growth: ["grow", "growing", "grew"],
  expectations: ["expect", "guidance", "target"], future: ["forward", "plan", "planned"], expenditure: ["capex"], changed: ["earlier", "revised", "now"],
  risk: ["risks", "challenge", "headwind", "concern"], risks: ["risk", "headwind", "challenge"],
  segment: ["segments", "division", "vertical", "business"], segments: ["segment", "vertical", "division"],
  business: ["segments", "operations", "products"], cash: ["cashflow", "receivables", "working"],
};

export function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z][a-z0-9-]*|\d+(?:\.\d+)?/g) ?? []).filter((w) => !STOP.has(w));
}

/** Paragraph-aware chunks of about `size` words, each keeping its page. */
export function chunkPages(docId: string, pages: string[], size = 140): Chunk[] {
  const out: Chunk[] = [];
  pages.forEach((p, i) => {
    const words = p.replace(/\s+/g, " ").trim().split(" ");
    if (words.length < 25) return;
    for (let at = 0; at < words.length; at += size - 20) {
      const slice = words.slice(at, at + size);
      if (slice.length < 25) break;
      out.push({ docId, page: i + 1, text: slice.join(" ") });
    }
  });
  return out;
}

/** Legal disclaimers and audit or ESG forms match words like "outlook" and "future" but never carry evidence. */
const BOILERPLATE = /forward[- ]looking statements?|safe harbou?r|actual results (could|may|might) (materially )?differ|audit evidence|assurance standard|essential indicator|internal financial controls/i;
export const dropBoilerplate = (chunks: Chunk[]) => chunks.filter((c) => !BOILERPLATE.test(c.text));

export function search(chunks: Chunk[], query: string, k = 6): Hit[] {
  const base = tokenize(query);
  const terms = new Map<string, number>();
  for (const t of base) {
    terms.set(t, 1);
    for (const syn of SYNONYMS[t] ?? []) if (!terms.has(syn)) terms.set(syn, 0.4);
  }
  if (!terms.size || !chunks.length) return [];
  const docs = chunks.map((c) => tokenize(c.text));
  const avg = docs.reduce((a, d) => a + d.length, 0) / docs.length;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) if (terms.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
  const K1 = 1.4, B = 0.75;
  const scored: Hit[] = [];
  chunks.forEach((c, i) => {
    const tf = new Map<string, number>();
    for (const t of docs[i]) if (terms.has(t)) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const [t, w] of terms) {
      const f = tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (chunks.length - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      score += w * idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * docs[i].length) / avg)));
    }
    if (score > 0) scored.push({ ...c, score: Math.round(score * 100) / 100 });
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, k);
}

/** Enough of the question's own terms must be present, otherwise we abstain instead of answering loosely. */
export function supported(hit: Hit | undefined, query: string): boolean {
  if (!hit) return false;
  const q = new Set(tokenize(query));
  if (!q.size) return false;
  const words = new Set(tokenize(hit.text));
  const expanded = [...q].filter((t) => words.has(t) || (SYNONYMS[t] ?? []).some((s) => words.has(s)));
  return expanded.length / q.size >= 0.5;
}

/** Every number in generated text must appear in the evidence, or the text is rejected. */
export function unverifiedNumbers(answer: string, evidence: string): string[] {
  const nums = (s: string) => (s.replace(/\[\d+\]/g, " ").match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, ""));
  const known = new Set(nums(evidence));
  return nums(answer).filter((n) => !known.has(n));
}
