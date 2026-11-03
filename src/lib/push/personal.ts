import { filingEvents, signalEvents, type MonitorEvent } from "../domain/monitor";
import { CATEGORIES, type Bar, type Category, type RawAnnouncement } from "../domain/types";
import { SYMBOL_RE } from "../portfolio";
import { FRESH_MS } from "./digest";
import { pushId, sameSecret, type PushDoc, type PushRecord } from "./subscription";

/**
 * Personalized background monitoring: each opted-in device's own symbols, thresholds and filing types, evaluated by
 * the same deterministic code as the app (filing classification and signalEvents). Pure; the cron supplies the data.
 */

export interface PersonalConfig {
  on: boolean;
  symbols: string[];
  pricePct: number;
  volumeMultiple: number;
  categories: Category[];
  updatedAt: string;
  /** Only events whose source time is at or after this count. Reset by every change, so nothing old is replayed. */
  effectiveFrom: string;
}

export const LIMITS = { symbolsPerDevice: 25, extraSymbols: 60, devices: 50, pricePct: [0.5, 50], volumeMultiple: [1.2, 50] } as const;

const PICKABLE = CATEGORIES.filter((c) => c !== "unclassified");

export type ParsedConfig = { ok: true; value: Pick<PersonalConfig, "symbols" | "pricePct" | "volumeMultiple" | "categories"> } | { ok: false; error: string };

export function parseConfig(v: unknown): ParsedConfig {
  if (!v || typeof v !== "object") return { ok: false, error: "Expected monitoring settings." };
  const { symbols, pricePct, volumeMultiple, categories } = v as Record<string, unknown>;
  if (!Array.isArray(symbols) || !symbols.length) return { ok: false, error: "Choose at least one company." };
  if (symbols.length > LIMITS.symbolsPerDevice) return { ok: false, error: `Background monitoring covers up to ${LIMITS.symbolsPerDevice} companies per device.` };
  if (!symbols.every((s) => typeof s === "string" && SYMBOL_RE.test(s))) return { ok: false, error: "Invalid NSE symbol." };
  const inRange = (x: unknown, [lo, hi]: readonly [number, number]) => typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi;
  if (!inRange(pricePct, LIMITS.pricePct)) return { ok: false, error: `Price threshold must be between ${LIMITS.pricePct[0]}% and ${LIMITS.pricePct[1]}%.` };
  if (!inRange(volumeMultiple, LIMITS.volumeMultiple)) return { ok: false, error: `Volume threshold must be between ${LIMITS.volumeMultiple[0]}× and ${LIMITS.volumeMultiple[1]}×.` };
  if (!Array.isArray(categories) || categories.length > PICKABLE.length || !categories.every((c) => (PICKABLE as string[]).includes(c as string))) return { ok: false, error: "Invalid filing type." };
  return { ok: true, value: { symbols: [...new Set(symbols as string[])].sort(), pricePct: pricePct as number, volumeMultiple: volumeMultiple as number, categories: [...new Set(categories as Category[])].sort() } };
}

export type PersonalChange = { doc: PushDoc; changed: boolean; result: "saved" | "unchanged" | "absent" | "full"; error?: string; config?: PersonalConfig };

/**
 * Saves (or turns off) one device's rules. Needs that device's endpoint and auth secret. Every change of rules
 * restarts `effectiveFrom`, so past events never qualify under new settings. Global caps keep the scan bounded.
 */
export function setPersonal(doc: PushDoc | null, endpoint: string, auth: string, next: ParsedConfig | null, shared: string[], now: Date): PersonalChange {
  const d: PushDoc = doc ?? { version: 1, subscriptions: [] };
  const i = d.subscriptions.findIndex((r) => r.id === pushId(endpoint));
  const r = d.subscriptions[i];
  if (i < 0 || r.endpoint !== endpoint || !sameSecret(r.keys.auth, auth)) return { doc: d, changed: false, result: "absent" };
  let config: PersonalConfig | undefined;
  if (next === null) {
    if (!r.personal?.on) return { doc: d, changed: false, result: "unchanged", config: r.personal };
    config = { ...r.personal, on: false, updatedAt: now.toISOString() };
  } else {
    if (!next.ok) return { doc: d, changed: false, result: "absent", error: next.error };
    const p = r.personal;
    const same = p?.on && JSON.stringify([p.symbols, p.pricePct, p.volumeMultiple, p.categories]) === JSON.stringify([next.value.symbols, next.value.pricePct, next.value.volumeMultiple, next.value.categories]);
    if (same) return { doc: d, changed: false, result: "unchanged", config: p };
    config = { on: true, ...next.value, updatedAt: now.toISOString(), effectiveFrom: now.toISOString() };
    const others = d.subscriptions.filter((s, j) => j !== i);
    if (!p?.on && others.filter((s) => s.personal?.on).length >= LIMITS.devices) return { doc: d, changed: false, result: "full", error: "Personal monitoring is at capacity right now." };
    if (extraSymbols([...others, { ...r, personal: config }], shared).length > LIMITS.extraSymbols) {
      return { doc: d, changed: false, result: "full", error: "FINN can't add more companies outside its demo list to background monitoring right now. Choose fewer, or companies from the demo portfolio." };
    }
  }
  const subscriptions = d.subscriptions.slice();
  subscriptions[i] = { ...r, personal: config };
  return { doc: { ...d, subscriptions }, changed: true, result: "saved", config };
}

/** Symbols the scan must price beyond the shared portfolio. One request per symbol however many devices pick it. */
export function extraSymbols(subs: PushRecord[], shared: string[]): string[] {
  const have = new Set(shared);
  return [...new Set(subs.filter((s) => s.personal?.on).flatMap((s) => s.personal!.symbols))].filter((s) => !have.has(s)).sort();
}

export interface ScanData {
  startedAt: string;
  /** Market-wide announcements read this run; null when the source failed, which is never treated as "no filings". */
  filings: RawAnnouncement[] | null;
  /** Bars per symbol; null for a symbol whose prices could not be read. */
  bars: Map<string, Bar[] | null>;
}

export interface DeviceMatch {
  events: MonitorEvent[];
  /** Selected companies whose prices weren't read, and whether filings were read: the digest says so. */
  unchecked: string[];
  filingsRead: boolean;
}

/** Why an event is not news for this device, or null if it qualifies. */
function reject(e: MonitorEvent, cfg: PersonalConfig, start: number): string | null {
  const at = Date.parse(e.at);
  if (!Number.isFinite(at) || at < Date.parse(cfg.effectiveFrom)) return "before these settings took effect";
  if (start - at > FRESH_MS || at - start > 24 * 3600e3) return "not recent";
  if (e.kind === "filing" && (e.priority === "routine" || !cfg.categories.includes(e.category!))) return "filing type not selected";
  return null;
}

export function matchDevice(cfg: PersonalConfig, data: ScanData, alreadySent: Set<string>): DeviceMatch {
  const start = Date.parse(data.startedAt);
  const mine = new Set(cfg.symbols);
  const events: MonitorEvent[] = [];
  if (data.filings) events.push(...filingEvents(data.filings, mine, [], data.startedAt, false));
  const unchecked: string[] = [];
  for (const s of cfg.symbols) {
    const b = data.bars.get(s);
    if (!b?.length) unchecked.push(s);
    else events.push(...signalEvents(s, b, { pricePct: cfg.pricePct, volumeMultiple: cfg.volumeMultiple }, data.startedAt, false));
  }
  return { events: events.filter((e) => !alreadySent.has(e.id) && !reject(e, cfg, start)), unchecked, filingsRead: data.filings != null };
}

/** Synthetic bars for an admin TEST: the last session moves by `movePct` on ordinary volume, nothing else. */
export function testBars(movePct: number, now: Date): Bar[] {
  const day = (i: number) => new Date(now.getTime() - (25 - i) * 24 * 3600e3).toISOString().slice(0, 10);
  const bars: Bar[] = Array.from({ length: 25 }, (_, i) => ({ date: day(i), close: 100, volume: 1000 }));
  bars.push({ date: now.toISOString().slice(0, 10), close: 100 * (1 + movePct / 100), volume: 1000 });
  return bars;
}
