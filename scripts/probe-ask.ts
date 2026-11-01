/** Manual check against the real provider. Usage: npx tsx --env-file=.env.local scripts/probe-ask.ts SYMBOL "question" ... */
import { ask } from "../src/lib/research/engine";
import { llmModelName } from "../src/lib/research/llm";

const QUESTIONS = [
  "What has management said about future capital expenditure?",
  "How has management's outlook changed between recent earnings calls?",
  "What evidence supports and contradicts management's growth expectations?",
  "What is the name of the CEO's pet and his favourite cricket team?",
];

async function main() {
  const [symbol, ...rest] = process.argv.slice(2);
  console.log("model", llmModelName());
  for (const q of rest.length ? rest : QUESTIONS) {
    const t = Date.now();
    const a = await ask(symbol, q);
    console.log(`\n### ${symbol}: ${q}\nmode=${a.mode} model=${a.model ?? "-"} ${((Date.now() - t) / 1000).toFixed(1)}s ${a.llmRejected ?? ""}`);
    for (const l of a.answer) console.log(`  > ${l}`);
    await new Promise((r) => setTimeout(r, Number(process.env.PACE_MS ?? 0)));
    a.citations.forEach((c, i) => console.log(`  [${i + 1}] ${c.title} p${c.page}\n      ${c.excerpt?.replace(/\s+/g, " ")}`));
  }
}

main();
