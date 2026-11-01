/** Manual live check of the research pipeline: npx tsx scripts/probe-research.ts TATAELXSI [question] */
import { ask, buildCase, getBusiness, getDocuments, getFinancials, getLedger, resolveCompany } from "../src/lib/research/engine";

const cr = (n: number | null) => (n == null ? "n/a" : `${(n / 1e7).toFixed(1)}`);

async function main() {
  const symbol = process.argv[2] ?? "TATAELXSI";
  const q = process.argv[3] ?? "What did management say about margins?";
  console.time("total");
  console.log(await resolveCompany(symbol));
  const fin = await getFinancials(symbol);
  console.log(fin.basis, fin.availableBases, fin.entityClass, fin.coverageNote);
  for (const p of fin.quarters) console.log(p.label, "rev", cr(p.revenue), "ebitda", cr(p.ebitda), "pbt", cr(p.pbt), "pat", cr(p.pat), "nii", cr(p.nii), p.source.filedAt);
  for (const p of fin.years) console.log(p.label, "rev", cr(p.revenue), "pat", cr(p.pat), "cfo", cr(p.cfo), "debt", cr(p.borrowings), "eq", cr(p.equity));
  const d = await getDocuments(symbol);
  console.log(d.discovery, d.docs.slice(0, 8).map((x) => `${x.kind}:${x.label}:${x.host}`));
  const led = await getLedger(symbol);
  console.log(led.counts, led.transcriptsRead);
  for (const r of led.rows) console.log(`[${r.evaluation.status}] ${r.claim.metric} ${r.claim.low}-${r.claim.high}${r.claim.unit} ${r.claim.periodText} | actual=${r.evaluation.actual?.value} | ${r.evaluation.reason}\n   ${r.claim.speaker} p${r.claim.page} (${r.callLabel}): ${r.claim.quote.slice(0, 200)}`);
  console.log(buildCase(fin, led).map((p) => `${p.side}: ${p.text}`));
  const b = await getBusiness(symbol);
  console.log(b.coverage, b.business.map((x) => `${x.text.slice(0, 200)} (p${x.citation.page})`));
  const a = await ask(symbol, q);
  console.log(a.mode, a.answer, a.citations.map((c) => `${c.title} p${c.page}`), a.coverage);
  console.timeEnd("total");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
