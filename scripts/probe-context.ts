/** Manual review aid: prints each scored claim with its page context, so a human can check it. Usage: tsx scripts/probe-context.ts SUPREMEIND HAL */
import { getLedger } from "../src/lib/research/engine";
import { loadPdf } from "../src/lib/sources/pdf";

async function main() {
  for (const s of process.argv.slice(2)) {
    const l = await getLedger(s);
    console.log(`\n=== ${s}`, l.counts);
    for (const r of l.rows.filter((x) => x.evaluation.actual)) {
      const pdf = await loadPdf(r.source.url, 60);
      const text = pdf.value.pages[r.claim.page - 1].replace(/\s+/g, " ");
      const at = text.indexOf(r.claim.quote.slice(0, 30));
      console.log(`[${r.evaluation.status}] ${r.claim.metric} ${r.claim.low}-${r.claim.high} ${r.claim.periodText} actual=${r.evaluation.actual!.value} ${r.source.url} p${r.claim.page} found=${at >= 0}`);
      console.log(`   ...${text.slice(Math.max(0, at - 450), at + r.claim.quote.length + 200)}...`);
    }
  }
}

main();
