/**
 * The scheduled job (GitHub Actions, see .github/workflows/ingest.yml), also runnable by hand with `npm run ingest`.
 * Writes timestamped snapshots of genuine data. A source that fails keeps its previous copy; nothing is synthesised.
 * Transcript text is not stored, only extracted claims with their citation.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { RawAnnouncement } from "../src/lib/domain/types";
import { DEFAULT_PORTFOLIO, RESEARCH_PICKS } from "../src/lib/portfolio";
import { getFinancials, getLedger, type Financials, type Ledger } from "../src/lib/research/engine";
import { mapLimit } from "../src/lib/sources/http";
import { fetchAnnouncements } from "../src/lib/sources/nse";
import { fetchHistory } from "../src/lib/sources/yahoo";

const MARKET = "data/snapshot/market.json";
const RESEARCH = "data/snapshot/research.json";

const read = <T>(p: string, d: T): T => (existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : d);

async function main() {
  const prevMarket = read(MARKET, { generatedAt: null, bars: {}, announcements: [] as RawAnnouncement[] });
  const prevResearch = read(RESEARCH, { generatedAt: null, financials: {} as Record<string, Financials>, ledgers: {} as Record<string, Ledger> });
  const portfolio = DEFAULT_PORTFOLIO.map((p) => p.symbol);
  const all = [...portfolio, ...RESEARCH_PICKS.map((p) => p.symbol)];

  const bars: Record<string, unknown> = { ...prevMarket.bars };
  let priceOk = 0;
  await mapLimit(all, 6, async (s) => {
    try {
      bars[s] = (await fetchHistory(s)).bars;
      priceOk++;
    } catch (e) {
      console.error(`prices ${s}: ${e instanceof Error ? e.message : e}`);
    }
  });

  let announcements = prevMarket.announcements;
  let annOk = false;
  try {
    const to = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
    const from = new Date(Date.now() - 31 * 24 * 3600e3).toISOString().slice(0, 10);
    const set = new Set(portfolio);
    const fresh = await fetchAnnouncements(from, to);
    announcements = fresh.filter((a) => set.has(a.symbol));
    annOk = true;
  } catch (e) {
    console.error(`announcements: ${e instanceof Error ? e.message : e}; keeping previous copy`);
  }

  const financials = { ...prevResearch.financials };
  const ledgers = { ...prevResearch.ledgers };
  let researchOk = 0;
  await mapLimit(all, 3, async (s) => {
    try {
      financials[s] = await getFinancials(s);
      ledgers[s] = await getLedger(s);
      researchOk++;
    } catch (e) {
      console.error(`research ${s}: ${e instanceof Error ? e.message : e}`);
    }
  });

  const generatedAt = new Date().toISOString();
  writeFileSync(MARKET, JSON.stringify({ generatedAt: annOk || priceOk ? generatedAt : prevMarket.generatedAt, bars, announcements }));
  writeFileSync(RESEARCH, JSON.stringify({ generatedAt: researchOk ? generatedAt : prevResearch.generatedAt, financials, ledgers }));
  console.log(`prices ${priceOk}/${all.length}, announcements ${annOk ? announcements.length : "kept previous"}, research ${researchOk}/${all.length}`);
  if (!priceOk && !annOk && !researchOk) process.exit(1);
}

main();
