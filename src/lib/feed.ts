import market from "../../data/snapshot/market.json";
import research from "../../data/snapshot/research.json";
import { buildBrief } from "./domain/classify";
import { evaluateSignals, priceMovePct, volumeMultiple, type SignalEvent } from "./domain/metrics";
import type { Bar, BriefItem, DataMode, Provenance, RawAnnouncement } from "./domain/types";
import type { Financials, Ledger } from "./research/engine";
import { cached, mapLimit } from "./sources/http";
import { fetchAnnouncements } from "./sources/nse";
import { fetchHistory } from "./sources/yahoo";

interface MarketSnapshot {
  generatedAt: string | null;
  bars: Record<string, Bar[]>;
  announcements: RawAnnouncement[];
}

interface ResearchSeed {
  generatedAt: string | null;
  financials: Record<string, Financials>;
  ledgers: Record<string, Ledger>;
}

export const marketSnapshot = market as unknown as MarketSnapshot;
export const researchSeed = research as unknown as ResearchSeed;

const MIN = 60e3;
const SEED_FRESH_MS = 48 * 3600e3;

const modeOf = (c: { mode: "live" | "cache"; stale: boolean }): DataMode => (c.mode === "live" ? "live" : "cache");

export function seedIsFresh(): boolean {
  return Boolean(researchSeed.generatedAt && Date.now() - Date.parse(researchSeed.generatedAt) < SEED_FRESH_MS);
}

/* ---------- prices ---------- */

export interface Quote {
  symbol: string;
  lastDate: string | null;
  close: number | null;
  movePct: number | null;
  volMultiple: number | null;
  closes: number[];
  dates: string[];
  events: SignalEvent[];
  mode: DataMode;
  fetchedAt: string | null;
  error?: string;
}

async function barsFor(symbol: string): Promise<{ bars: Bar[]; mode: DataMode; fetchedAt: string | null; error?: string }> {
  try {
    const c = await cached(`eod:${symbol}`, 30 * MIN, () => fetchHistory(symbol));
    return { bars: c.value.bars, mode: c.stale ? "cache" : modeOf(c), fetchedAt: c.fetchedAt };
  } catch (e) {
    const snap = marketSnapshot.bars[symbol];
    if (snap?.length) return { bars: snap, mode: "snapshot", fetchedAt: marketSnapshot.generatedAt };
    return { bars: [], mode: "snapshot", fetchedAt: null, error: e instanceof Error ? e.message : "Price source unavailable" };
  }
}

export async function getQuotes(symbols: string[], rule: { pricePct: number; volumeMultiple: number }, sessions = 10): Promise<Quote[]> {
  return mapLimit(symbols, 6, async (symbol) => {
    const { bars, mode, fetchedAt, error } = await barsFor(symbol);
    return {
      symbol,
      lastDate: bars.at(-1)?.date ?? null,
      close: bars.at(-1)?.close ?? null,
      movePct: priceMovePct(bars),
      volMultiple: volumeMultiple(bars),
      closes: bars.slice(-30).map((b) => b.close),
      dates: bars.slice(-30).map((b) => b.date),
      events: evaluateSignals(bars, rule, sessions),
      mode, fetchedAt, error,
    };
  });
}

/* ---------- filings ---------- */

export interface BriefResponse {
  items: BriefItem[];
  counts: { total: number; raw: number; critical: number; notable: number; routine: number; companies: number };
  provenance: Provenance;
}

export async function getBrief(symbols: string[], fromIso: string, toIso: string): Promise<BriefResponse> {
  const fromDay = new Date(Date.parse(fromIso) + 5.5 * 3600e3).toISOString().slice(0, 10);
  const toDay = new Date(Date.parse(toIso) + 5.5 * 3600e3).toISOString().slice(0, 10);
  const want = new Set(symbols);
  let raw: RawAnnouncement[];
  let provenance: Provenance;
  try {
    // One market-wide call is far cheaper than one call per holding, and one cache entry serves every portfolio.
    const c = await cached(`ann:${fromDay}:${toDay}`, 10 * MIN, () => fetchAnnouncements(fromDay, toDay));
    raw = c.value;
    provenance = {
      source: "NSE corporate announcements", fetchedAt: c.fetchedAt, mode: modeOf(c),
      note: c.stale ? "NSE did not respond. Showing the last good copy." : undefined,
    };
  } catch {
    raw = marketSnapshot.announcements;
    provenance = {
      source: "NSE corporate announcements", fetchedAt: marketSnapshot.generatedAt ?? new Date(0).toISOString(), mode: "snapshot",
      note: "NSE is not reachable from this server. Showing genuine filings saved by the last scheduled run.",
    };
  }
  const inWindow = raw.filter((a) => want.has(a.symbol) && a.at >= isoIst(fromIso) && a.at <= isoIst(toIso));
  const items = buildBrief(inWindow);
  const n = (p: string) => items.filter((i) => i.priority === p).length;
  return {
    items,
    counts: { total: items.length, raw: inWindow.length, critical: n("critical"), notable: n("notable"), routine: n("routine"), companies: new Set(items.map((i) => i.symbol)).size },
    provenance,
  };
}

/** Announcement timestamps are ISO strings at +05:30, so bounds must be too for string comparison. */
function isoIst(iso: string): string {
  return `${new Date(Date.parse(iso) + 5.5 * 3600e3).toISOString().slice(0, 19)}+05:30`;
}
