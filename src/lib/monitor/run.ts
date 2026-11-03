import { randomUUID } from "node:crypto";
import { applyRun, emptyState, filingEvents, filingWindow, RUN_LOCK_MS, sessionStatus, signalEvents, statusOf, type MonitorEvent, type MonitorState, type RunRecord, type Trigger } from "../domain/monitor";
import type { SignalRule } from "../domain/metrics";
import type { Bar, RawAnnouncement } from "../domain/types";
import { mapLimit } from "../sources/http";

export interface MonitorStore {
  read(fresh: boolean): Promise<{ state: MonitorState; etag: string } | null>;
  /** False if someone else wrote first, so the caller can re-read and merge. */
  write(state: MonitorState, etag: string | null): Promise<boolean>;
}

export interface ScanDeps {
  store: MonitorStore;
  symbols: string[];
  rule: SignalRule;
  fetchFilings: (from: string, to: string) => Promise<RawAnnouncement[]>;
  fetchBars: (symbol: string) => Promise<Bar[]>;
  now?: () => number;
  retryDelayMs?: number;
}

export type ScanResult = { outcome: "skipped"; runningSince: string } | { outcome: "finished"; run: RunRecord; added: MonitorEvent[] };

const reason = (e: unknown) => (e instanceof Error ? e.message : "unknown error").slice(0, 160);

/** Deliberately no cache or snapshot here: a scan may only report what it read from the source just now. */
async function attempt<T>(fn: () => Promise<T>, delayMs: number): Promise<T> {
  try {
    return await fn();
  } catch {
    await new Promise((res) => setTimeout(res, delayMs));
    return fn();
  }
}

/** Writes through a conflict by re-reading and re-applying, so a duplicate invocation can't lose either run's work. */
async function commit(store: MonitorStore, change: (s: MonitorState) => MonitorState) {
  for (let i = 0; i < 4; i++) {
    const cur = await store.read(true);
    if (await store.write(change(cur?.state ?? emptyState()), cur?.etag ?? null)) return;
  }
  throw new Error("Monitoring store kept changing during the write");
}

export async function runScan(deps: ScanDeps, trigger: Trigger): Promise<ScanResult> {
  const { store, symbols, rule, fetchFilings, fetchBars, now = Date.now, retryDelayMs = 2000 } = deps;
  const started = now();
  const startedAt = new Date(started).toISOString();
  const existing = await store.read(true);
  const before = existing?.state ?? emptyState();
  if (before.current && started - Date.parse(before.current.startedAt) < RUN_LOCK_MS) return { outcome: "skipped", runningSince: before.current.startedAt };

  const runId = randomUUID();
  await commit(store, (s) => ({ ...s, current: { runId, trigger, startedAt } }));

  const errors: string[] = [];
  const events: MonitorEvent[] = [];
  const portfolio = new Set(symbols);

  const { from, to } = filingWindow(before.filingsScannedAt, started);
  let filingsChecked: number | null = null;
  try {
    const raw = await attempt(() => fetchFilings(from, to), retryDelayMs);
    // A market-wide window of three days or more is never empty. Empty means the source failed quietly.
    if (!raw.length) throw new Error("NSE returned no filings for the whole market");
    const mine = raw.filter((a) => portfolio.has(a.symbol));
    filingsChecked = mine.length;
    events.push(...filingEvents(raw, portfolio, before.events, startedAt, before.filingsScannedAt == null));
  } catch (e) {
    errors.push(`NSE announcements not read: ${reason(e)}`);
  }

  const bars = await mapLimit(symbols, 4, async (symbol) => {
    try {
      const b = await attempt(() => fetchBars(symbol), retryDelayMs);
      if (!b.length) throw new Error("no sessions returned");
      return { symbol, bars: b };
    } catch (e) {
      return { symbol, bars: null as Bar[] | null, error: reason(e) };
    }
  });
  const read = bars.filter((b): b is { symbol: string; bars: Bar[] } => b.bars != null);
  const failed = bars.filter((b) => b.bars == null);
  if (failed.length) errors.push(`Prices not read for ${failed.map((f) => f.symbol).join(", ")}: ${(failed[0] as { error?: string }).error}`);
  const latestSession = read.reduce<string | null>((m, b) => { const d = b.bars.at(-1)!.date; return !m || d > m ? d : m; }, null);
  const lagging = read.filter((b) => b.bars.at(-1)!.date !== latestSession).map((b) => b.symbol);
  if (lagging.length) errors.push(`No ${latestSession} session for ${lagging.join(", ")}`);
  for (const b of read) events.push(...signalEvents(b.symbol, b.bars, rule, startedAt, before.signalsScannedAt == null));

  const run: RunRecord = {
    runId, trigger, startedAt, finishedAt: new Date(now()).toISOString(),
    status: statusOf(filingsChecked != null, symbols.length, read.length, failed.length, lagging.length),
    companiesExpected: symbols.length, companiesChecked: read.length, companiesFailed: failed.map((f) => f.symbol), companiesLagging: lagging,
    filingsChecked, windowFrom: from, windowTo: to, latestSession, sessionStatus: sessionStatus(latestSession, now()), newEvents: 0, errors,
  };
  // Only events this run's own commit added: a re-run or a concurrent run can never claim the same event twice.
  let added: MonitorEvent[] = [];
  await commit(store, (s) => {
    const r = applyRun(s, run, events, { filings: filingsChecked != null, signals: read.length === symbols.length });
    added = r.addedEvents;
    return r.state;
  });
  return { outcome: "finished", run: { ...run, newEvents: added.length }, added };
}
