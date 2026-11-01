/** Manual live check of guidance extraction across companies: npx tsx scripts/probe-guidance.ts KPITTECH DIXON */
import { getLedger } from "../src/lib/research/engine";

async function main() {
  for (const s of process.argv.slice(2)) {
    try {
      const l = await getLedger(s);
      console.log(`\n=== ${s} ${l.basis}`, l.counts, l.transcriptsRead.map((t) => `${t.label}:${t.pages}p/${t.claims}c${t.error ? "!" + t.error : ""}`).join(" "));
      for (const r of l.rows) {
        console.log(`[${r.evaluation.status}] ${r.claim.metric} ${r.claim.low}-${r.claim.high}${r.claim.unit ?? ""} per=${r.claim.periodText} act=${r.evaluation.actual?.value ?? "-"} var=${r.evaluation.variance ?? "-"} | ${r.evaluation.reason}`);
        console.log(`    ${r.claim.speaker} p${r.claim.page} ${r.callLabel}: ${r.claim.quote.slice(0, 230)}`);
      }
    } catch (e) {
      console.log(`=== ${s} FAILED`, e instanceof Error ? e.message : e);
    }
  }
}

main();
