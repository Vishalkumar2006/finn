import { buildBrief } from "./classify";
import { evaluateSignals, type SignalRule } from "./metrics";
import type { Bar, Category, Priority, RawAnnouncement } from "./types";

/** Pure rules for the scheduled scan. Prices and thresholds go through the same code as the app's own alerts. */

export type RunStatus = "running" | "success" | "partial" | "failed";
export type Trigger = "cron" | "manual";
export type SessionStatus = "traded_today" | "weekend" | "not_closed_yet" | "no_bars_today" | "unavailable";

export interface MonitorEvent {
  id: string;
  kind: "filing" | "price" | "volume";
  symbol: string;
  at: string; // source time: filing timestamp, or the EOD session date
  detectedAt: string;
  baseline: boolean; // already public when monitoring of this source began, so not news
  // filing
  company?: string;
  category?: Category;
  priority?: Priority;
  summary?: string;
  why?: string;
  url?: string | null;
  seqId?: string;
  relatedSeqIds?: string[];
  // price or volume
  session?: string;
  value?: number;
  threshold?: number;
  close?: number;
}

export interface RunRecord {
  runId: string;
  trigger: Trigger;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  companiesExpected: number;
  companiesChecked: number;
  companiesFailed: string[];
  companiesLagging: string[];
  filingsChecked: number | null; // null means the filings source was not read, which is different from zero
  windowFrom: string | null;
  windowTo: string | null;
  latestSession: string | null;
  sessionStatus: SessionStatus;
  newEvents: number;
  errors: string[];
}

export interface MonitorState {
  version: 1;
  current: { runId: string; trigger: Trigger; startedAt: string } | null;
  lastRun: RunRecord | null;
  lastSuccess: RunRecord | null;
  lastAutomatic: RunRecord | null;
  filingsScannedAt: string | null;
  signalsScannedAt: string | null;
  runs: RunRecord[];
  events: MonitorEvent[];
}

export const emptyState = (): MonitorState => ({
  version: 1, current: null, lastRun: null, lastSuccess: null, lastAutomatic: null, filingsScannedAt: null, signalsScannedAt: null, runs: [], events: [],
});

const DAY = 24 * 3600e3;
const istDay = (ms: number) => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10);

/** Everything since the last good filings read, so a missed day catches up. Never under 3 days or over 7. */
export function filingWindow(lastScan: string | null, now: number): { from: string; to: string } {
  const since = lastScan ? Date.parse(lastScan) - 2 * DAY : now - 7 * DAY;
  const from = Math.min(now - 3 * DAY, Math.max(now - 7 * DAY, since));
  return { from: istDay(from), to: istDay(now) };
}

/** Which filing numbers are already recorded, including those clustered under another filing. */
function seenFilings(events: MonitorEvent[]): Set<string> {
  const seen = new Set<string>();
  for (const e of events) {
    if (e.seqId) seen.add(e.seqId);
    e.relatedSeqIds?.forEach((s) => seen.add(s));
  }
  return seen;
}

/** New filings only, classified by the Brief's own rules. Stores the short summary and link, never the document. */
export function filingEvents(raw: RawAnnouncement[], portfolio: Set<string>, known: MonitorEvent[], nowIso: string, baseline: boolean): MonitorEvent[] {
  const seen = seenFilings(known);
  const fresh = raw.filter((a) => portfolio.has(a.symbol) && !seen.has(a.seqId));
  return buildBrief(fresh).map((i) => ({
    id: `f:${i.seqId}`, kind: "filing", symbol: i.symbol, at: i.at, detectedAt: nowIso, baseline,
    company: i.company, category: i.category, priority: i.priority, summary: i.summary, why: i.why,
    url: i.url?.startsWith("https://") ? i.url : null, seqId: i.seqId, relatedSeqIds: i.related.map((r) => r.seqId),
  }));
}

/** One event per company, session and signal type, so rescanning a session can't repeat it. */
export function signalEvents(symbol: string, bars: Bar[], rule: SignalRule, nowIso: string, baseline: boolean, sessions = 5): MonitorEvent[] {
  return evaluateSignals(bars, rule, sessions).map((e) => ({
    id: `s:${symbol}:${e.date}:${e.type}`, kind: e.type, symbol, at: `${e.date}T15:30:00+05:30`, detectedAt: nowIso, baseline,
    session: e.date, value: e.value, threshold: e.threshold, close: e.close,
  }));
}

/** No exchange calendar is used, so a weekday without bars is reported as exactly that, not called a holiday. */
export function sessionStatus(latest: string | null, now: number): SessionStatus {
  if (!latest) return "unavailable";
  const today = istDay(now);
  if (latest >= today) return "traded_today";
  const ist = new Date(now + 5.5 * 3600e3);
  const dow = ist.getUTCDay();
  if (dow === 0 || dow === 6) return "weekend";
  return ist.getUTCHours() * 60 + ist.getUTCMinutes() < 15 * 60 + 45 ? "not_closed_yet" : "no_bars_today";
}

/** Success means every source was actually read. Finding nothing is fine; not looking is not. */
export function statusOf(filingsOk: boolean, expected: number, checked: number, failed: number, lagging: number): RunStatus {
  if (!filingsOk && checked === 0) return "failed";
  if (filingsOk && checked === expected && failed === 0 && lagging === 0) return "success";
  return "partial";
}

const KEEP_DAYS = 120;
const KEEP_EVENTS = 800;
const KEEP_RUNS = 30;

/** Merges one finished run. Safe to repeat: events and runs are keyed, and the earliest detection is kept. */
export function applyRun(state: MonitorState, run: RunRecord, events: MonitorEvent[], scanned: { filings: boolean; signals: boolean }): { state: MonitorState; added: number } {
  const byId = new Map(state.events.map((e) => [e.id, e]));
  const seen = seenFilings(state.events);
  let added = 0;
  for (const e of events) {
    if (byId.has(e.id) || (e.seqId && seen.has(e.seqId))) continue;
    byId.set(e.id, e);
    added++;
  }
  const cutoff = Date.parse(run.startedAt) - KEEP_DAYS * DAY;
  const kept = [...byId.values()]
    .filter((e) => Date.parse(e.detectedAt) >= cutoff)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, KEEP_EVENTS);
  const record = { ...run, newEvents: added };
  const prior = state.runs.filter((r) => r.runId !== run.runId);
  return {
    added,
    state: {
      ...state,
      current: state.current?.runId === run.runId ? null : state.current,
      lastRun: record,
      lastSuccess: record.status === "success" ? record : state.lastSuccess,
      lastAutomatic: record.trigger === "cron" ? record : state.lastAutomatic,
      filingsScannedAt: scanned.filings ? run.startedAt : state.filingsScannedAt,
      signalsScannedAt: scanned.signals ? run.startedAt : state.signalsScannedAt,
      runs: [record, ...prior].slice(0, KEEP_RUNS),
      events: kept,
    },
  };
}

export const RUN_LOCK_MS = 3 * 60e3;
export const STALE_AFTER_MS = 36 * 3600e3;

/** A daily job should never be this far behind. A run that never finished counts against it too. */
export function monitorHealth(state: MonitorState | null, now: number): { stale: boolean; stuck: boolean } {
  const started = state?.current ? Date.parse(state.current.startedAt) : null;
  const last = state?.lastSuccess ? Date.parse(state.lastSuccess.startedAt) : null;
  return { stuck: started != null && now - started > RUN_LOCK_MS, stale: last == null || now - last > STALE_AFTER_MS };
}
