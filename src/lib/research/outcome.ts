import { renumber, parseModelAnswer, sanitisePassage } from "../domain/answerCheck";
import { managementPages } from "../domain/guidance";
import { buildOutcome, checkExplanation, factsPassage, outcomeIntent, type Outcome, type OutcomeItem } from "../domain/outcome";
import { chunkPages, search, type Hit } from "../domain/retrieval";
import type { SourceRef } from "../domain/types";
import { researchSeed, seedIsFresh } from "../feed";
import { cached } from "../sources/http";
import { loadPdf } from "../sources/pdf";
import { addTiming, timed } from "../timing";
import { ask, diversify, getLedger, type Answer, type Ledger, type LedgerRow } from "./engine";
import { allowLlmCall } from "./guard";
import { complete, EXPLAIN_GUARD, explainVersion, llmEnabled, llmModelName } from "./llm";
import { createHash } from "node:crypto";

const HOUR = 3600e3;
// A ledger not ready by now means an unfamiliar company with many unread calls. Search answers now; the reads finish into the cache.
const LEDGER_BUDGET_MS = 30000;
const CONTEXT_BUDGET_MS = 8000;

/** The one way to get a company's ledger: saved analysis while fresh, then live, then saved analysis as a fallback. */
export async function ledgerOf(symbol: string): Promise<{ led: Ledger; seeded: boolean }> {
  const seed = researchSeed.ledgers[symbol];
  if (seed && seedIsFresh()) return { led: seed, seeded: true };
  try {
    return { led: await getLedger(symbol), seeded: false };
  } catch (e) {
    if (seed) return { led: seed, seeded: true };
    throw e;
  }
}

export type IntegratedAnswer = Answer & { outcome?: Outcome<LedgerRow> };

const within = <T,>(p: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([p, new Promise<null>((res) => setTimeout(() => res(null), ms))]);

/** Only the calls behind the verdicts are opened, around the statement itself. Annual reports stay out of it. */
async function contextPassages(items: OutcomeItem<LedgerRow>[], question: string): Promise<{ hit: Hit; source: SourceRef }[]> {
  const out: { hit: Hit; source: SourceRef }[] = [];
  const calls = [...new Map(items.map((i) => [i.row.source.url, i])).values()].slice(0, 2);
  await Promise.all(calls.map(async (i) => {
    const pdf = await loadPdf(i.row.source.url, 60);
    const chunks = chunkPages(i.row.source.url, managementPages(pdf.value.pages));
    const hits = diversify([...search(chunks, i.row.claim.quote, 2), ...search(chunks, question, 4)], 3);
    for (const hit of hits) out.push({ hit, source: { ...i.row.source, page: hit.page, excerpt: hit.text.slice(0, 1400) } });
  }));
  return out;
}

/** Optional text beside the card. Any failure leaves the deterministic card exactly as it was. */
async function explain(symbol: string, question: string, outcome: Outcome<LedgerRow>): Promise<Pick<Outcome<LedgerRow>, "explanation" | "explanationNote">> {
  if (!llmEnabled() || !outcome.items.length) return {};
  if (!allowLlmCall()) return { explanationNote: "The daily model allowance is used up, so this has no written explanation." };
  const context = await within(contextPassages(outcome.items, question).catch(() => []), CONTEXT_BUDGET_MS);
  if (!context?.length) return { explanationNote: "The transcripts were not ready in time, so this has no written explanation." };
  const facts = outcome.items.map((i) => ({ text: factsPassage(i, outcome.basis), source: i.row.evaluation.actual?.source ?? i.row.source, title: i.row.evaluation.actual ? `Verified result, ${i.row.evaluation.actual.label}` : "Verified status" }));
  const passages = [...facts, ...context.map((c) => ({ text: c.hit.text, source: c.source, title: c.source.title }))];
  const key = `explain:${explainVersion()}:${llmModelName()}:${symbol}:${question.toLowerCase().replace(/\s+/g, " ").trim()}:${createHash("sha1").update(JSON.stringify(passages.map((p) => p.text))).digest("hex").slice(0, 16)}`;
  try {
    const c = await cached(key, 6 * HOUR, async () => {
      const blocks = passages.map((p, i) => `<passage id="${i + 1}" source="${p.title.replace(/[<>"]/g, "")}${p.source.page ? `, page ${p.source.page}` : ""}">\n${sanitisePassage(p.text)}\n</passage>`).join("\n");
      const r = await timed("llm", () => complete(`${blocks}\n\nQuestion: ${question}`, EXPLAIN_GUARD));
      if (!r.ok) throw new Error("the model did not answer");
      const parsed = parseModelAnswer(r.text);
      if (!parsed) throw new Error("its reply was malformed");
      const checked = checkExplanation(parsed, passages.map((p) => `${p.title}. ${p.text}`), outcome.items);
      if (!checked.ok) throw new Error(checked.reason);
      const { lines, used } = renumber(checked.claims);
      return { lines, citations: used.map((n) => passages[n - 1].source), model: r.model };
    });
    return { explanation: c.value };
  } catch (e) {
    const why = e instanceof Error ? e.message : "it failed";
    console.error(`llm: explanation not used: ${why}`);
    return { explanationNote: `A model explanation was not shown because ${why}. The figures and verdict above come from the filings and are unaffected.` };
  }
}

export async function answerQuestion(symbol: string, question: string, previous?: string): Promise<IntegratedAnswer> {
  const intent = outcomeIntent(question, new Date().toISOString().slice(0, 10));
  if (!intent) return ask(symbol, question, previous);

  const t0 = Date.now();
  const loaded = await within(ledgerOf(symbol).catch(() => null), LEDGER_BUDGET_MS);
  addTiming("ledger", Date.now() - t0);
  if (!loaded) {
    const a = await ask(symbol, question, previous);
    return { ...a, note: `${a.note ? `${a.note} ` : ""}Filed results or transcripts could not be matched in time, so this answer has no verdict. Said vs delivered may have one.` };
  }
  const built = buildOutcome(loaded.led.rows, loaded.led.basis, intent);
  const read = loaded.led.transcriptsRead.filter((t) => !t.error).map((t) => t.label);
  const outcome: Outcome<LedgerRow> = { ...built, transcripts: read, seeded: loaded.seeded };
  if (!built.items.length) {
    // Nothing comparable: say so, then answer from the documents as usual.
    const a = await ask(symbol, question, previous);
    return { ...a, outcome };
  }
  const written = await explain(symbol, question, outcome);
  return {
    mode: "outcome", answer: built.summary, citations: [], model: written.explanation?.model,
    coverage: loaded.led.transcriptsRead.map((t) => (t.error ? `${t.label} call: not readable (${t.error})` : `${t.label} call: ${t.pages} pages`)),
    outcome: { ...outcome, ...written },
  };
}
