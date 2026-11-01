import type { Bar } from "../domain/types";
import { get, SourceError } from "./http";

export interface PriceHistory {
  symbol: string;
  currency: string;
  bars: Bar[];
}

/** Keeps only completed sessions with both close and volume; a missing value is dropped, never zero-filled. */
export function parseChart(json: unknown, symbol: string, now = new Date()): PriceHistory {
  const res = (json as { chart?: { result?: unknown[] } })?.chart?.result?.[0] as
    | { meta?: { currency?: string }; timestamp?: number[]; indicators?: { quote?: { close?: (number | null)[]; volume?: (number | null)[] }[] } }
    | undefined;
  if (!res?.timestamp) throw new SourceError("yahoo", null, `no price data for ${symbol}`);
  const q = res.indicators?.quote?.[0];
  const ist = (t: number) => new Date(t * 1000 + 5.5 * 3600e3).toISOString().slice(0, 10);
  const nowIst = new Date(now.getTime() + 5.5 * 3600e3);
  const today = nowIst.toISOString().slice(0, 10);
  const closedToday = nowIst.getUTCHours() * 60 + nowIst.getUTCMinutes() >= 15 * 60 + 45;
  const bars: Bar[] = [];
  res.timestamp.forEach((t, i) => {
    const close = q?.close?.[i];
    const volume = q?.volume?.[i];
    const date = ist(t);
    if (close == null || volume == null) return;
    if (date === today && !closedToday) return; // an open session is not an end-of-day bar
    bars.push({ date, close: Math.round(close * 100) / 100, volume });
  });
  return { symbol, currency: res.meta?.currency ?? "INR", bars };
}

export async function fetchHistory(symbol: string, range = "6mo"): Promise<PriceHistory> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}.NS?range=${range}&interval=1d`;
  const r = await get(url, { source: "yahoo", timeoutMs: 8000, retries: 0 });
  return parseChart(await r.json(), symbol);
}

export interface YahooMatch {
  symbol: string;
  name: string;
}

export async function searchYahoo(q: string): Promise<YahooMatch[]> {
  const r = await get(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`, { source: "yahoo" });
  const j = (await r.json()) as { quotes?: { symbol?: string; longname?: string; shortname?: string; quoteType?: string }[] };
  return (j.quotes ?? [])
    .filter((x) => x.quoteType === "EQUITY" && x.symbol?.endsWith(".NS"))
    .map((x) => ({ symbol: x.symbol!.replace(/\.NS$/, ""), name: x.longname ?? x.shortname ?? x.symbol! }));
}
