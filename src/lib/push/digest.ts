import type { MonitorEvent, RunRecord } from "../domain/monitor";
import { safePath, type PushPayload, type PushRecord } from "./subscription";

/**
 * Daily digest rules. Pure and deterministic: counts and wording come from stored monitoring events, never a model.
 */

/** A filing or session older than this when first seen is not news (a missed scan catching up still fits). */
export const FRESH_MS = 4 * 24 * 3600e3;

/** Events this run itself added that are new, material and recent. Anything older, routine or baseline never qualifies. */
export function qualifying(run: RunRecord, added: MonitorEvent[]): MonitorEvent[] {
  if (run.status === "failed" || run.status === "running") return [];
  const start = Date.parse(run.startedAt);
  return added.filter((e) => {
    if (e.baseline || e.detectedAt !== run.startedAt) return false;
    if (e.kind === "filing" && e.priority === "routine") return false;
    const at = Date.parse(e.at);
    return Number.isFinite(at) && start - at <= FRESH_MS && at - start <= 24 * 3600e3;
  });
}

const sign = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One notification for the whole run. Null when nothing qualifies, so a quiet day sends nothing. */
export function digestPayload(run: RunRecord, events: MonitorEvent[], personal?: { unchecked: string[]; filingsRead: boolean }): PushPayload | null {
  if (!events.length) return null;
  const gaps = personal && [!personal.filingsRead && "filings not read", personal.unchecked.length && `no prices for ${personal.unchecked.slice(0, 3).join(", ")}${personal.unchecked.length > 3 ? " and more" : ""}`].filter(Boolean);
  const partial = personal
    ? gaps!.length ? ` Scan incomplete: ${gaps!.join("; ")}.` : ""
    : run.status === "partial" ? ` Scan incomplete: ${run.companiesChecked} of ${run.companiesExpected} companies read.` : "";
  const whose = personal ? "your" : "the shared";
  const tag = `finn-${personal ? "mine" : "daily"}-${run.runId.slice(0, 8)}`;
  if (events.length === 1) {
    const e = events[0];
    const url = safePath(`/research/${e.symbol}`);
    if (e.kind === "filing") {
      return { title: `FINN: ${e.symbol} filing`, body: clip(`${e.summary ?? "New important filing"}. Filed ${day(e.at)}.`, 150) + partial, url, tag };
    }
    if (e.kind === "price") {
      return { title: `FINN: ${e.symbol} closed ${sign(e.value ?? 0)}`, body: `End-of-day move on ${day(e.at)}, beyond ${whose} ±${e.threshold}% rule. Tap to review.${partial}`, url, tag };
    }
    return { title: `FINN: ${e.symbol} volume ${e.value}×`, body: `${e.value}× its prior 20-session average on ${day(e.at)}, above ${whose} ${e.threshold}× rule.${partial}`, url, tag };
  }
  const filings = events.filter((e) => e.kind === "filing").length;
  const moves = events.length - filings;
  const companies = [...new Set(events.map((e) => e.symbol))];
  const parts = [filings && plural(filings, "important filing", "important filings"), moves && plural(moves, "unusual EOD move", "unusual EOD moves")].filter(Boolean);
  const names = companies.length <= 3 ? companies.join(", ") : `${companies.slice(0, 3).join(", ")} and ${companies.length - 3} more`;
  return {
    title: personal ? `FINN: ${events.length} signals in your portfolio` : `FINN: ${events.length} portfolio signals`,
    body: `${parts.join(" and ")} (${names}). Tap to review the evidence.${partial}`,
    url: personal ? "/alerts#my-alerts" : "/alerts",
    tag,
  };
}

/** Consent given before this scan started. Turning alerts on later never reaches back to earlier scans. */
export const eligible = (subs: PushRecord[], run: RunRecord) =>
  // A device on personal monitoring gets its own digest instead, never both.
  subs.filter((s) => s.daily?.on && !s.personal?.on && Date.parse(s.daily.since) <= Date.parse(run.startedAt));

// Delivery ledger: one record per run, one entry per device. An entry is claimed before the send and never re-sent.

export type Outcome = "claimed" | "sent" | "failed" | "expired";

export interface DigestRecord {
  runId: string;
  createdAt: string;
  eventIds: string[];
  payload: PushPayload;
  recipients: Record<string, { status: Outcome; at: string; code?: number }>;
  /** Personal digests: one device, and the events themselves so the device can see what triggered it. */
  deviceId?: string;
  events?: MonitorEvent[];
  gaps?: { unchecked: string[]; filingsRead: boolean };
}

export interface PersonalRunSummary {
  runId: string;
  startedAt: string;
  runStatus: RunRecord["status"];
  filingsRead: boolean;
  /** Companies some device asked for whose prices could not be read in this run. */
  unchecked: string[];
}

export interface DeliveryDoc {
  version: 1;
  digests: DigestRecord[];
  /** The last few scans as personal monitoring saw them, so a device can tell whether its last scan was complete. */
  personalRuns?: PersonalRunSummary[];
}

export function notePersonalRun(doc: DeliveryDoc | null, s: PersonalRunSummary) {
  const d: DeliveryDoc = doc ?? { version: 1, digests: [] };
  if (d.personalRuns?.some((x) => x.runId === s.runId)) return { doc: d, changed: false };
  return { doc: { ...d, personalRuns: [s, ...(d.personalRuns ?? [])].slice(0, 10) }, changed: true };
}

/** Longer than the 4-day freshness window, so an event can never age out of the ledger and then be sent again. */
const KEEP_MS = 14 * 24 * 3600e3;
const KEEP_MAX = 1200;
const prune = (digests: DigestRecord[], now: Date) => digests.filter((x) => now.getTime() - Date.parse(x.createdAt) < KEEP_MS).slice(0, KEEP_MAX);

export type Claim = { doc: DeliveryDoc; changed: boolean; claimed: string[] };

/** Claims up to `max` devices that no invocation has claimed for this run. The conditional write makes a claim exclusive. */
export function claim(doc: DeliveryDoc | null, digest: Omit<DigestRecord, "recipients">, ids: string[], now: Date, max: number): Claim {
  const d: DeliveryDoc = doc ?? { version: 1, digests: [] };
  const existing = d.digests.find((x) => x.runId === digest.runId);
  const rec: DigestRecord = existing ? { ...existing, recipients: { ...existing.recipients } } : { ...digest, recipients: {} };
  const claimed = ids.filter((id) => !rec.recipients[id]).slice(0, max);
  if (existing && !claimed.length) return { doc: d, changed: false, claimed };
  for (const id of claimed) rec.recipients[id] = { status: "claimed", at: now.toISOString() };
  const digests = prune([rec, ...d.digests.filter((x) => x.runId !== digest.runId)], now);
  return { doc: { ...d, digests }, changed: true, claimed };
}

/** Records what the push service said. Only entries this invocation claimed are touched. */
export function record(doc: DeliveryDoc | null, runId: string, results: { id: string; status: Exclude<Outcome, "claimed">; code?: number }[], now: Date) {
  const d: DeliveryDoc = doc ?? { version: 1, digests: [] };
  const i = d.digests.findIndex((x) => x.runId === runId);
  if (i < 0) return { doc: d, changed: false };
  const rec = { ...d.digests[i], recipients: { ...d.digests[i].recipients } };
  for (const r of results) if (rec.recipients[r.id]?.status === "claimed") rec.recipients[r.id] = { status: r.status, at: now.toISOString(), ...(r.code ? { code: r.code } : {}) };
  const digests = d.digests.slice();
  digests[i] = rec;
  return { doc: { ...d, digests }, changed: true };
}

/** Every event this device has been sent, or claimed for, in the ledger's retention window. */
export function notifiedFor(doc: DeliveryDoc | null, deviceId: string): Set<string> {
  const out = new Set<string>();
  for (const d of doc?.digests ?? []) if (d.recipients[deviceId]) d.eventIds.forEach((id) => out.add(id));
  return out;
}

export interface PersonalItem {
  deviceId: string;
  events: MonitorEvent[];
  gaps: { unchecked: string[]; filingsRead: boolean };
}

export const personalKey = (runId: string, deviceId: string) => `${runId}:${deviceId}`;

/**
 * Claims one personal digest per device for this run. "Already sent" is re-checked against the document being
 * written, so two runs racing can't both claim the same event for the same device.
 */
export function claimPersonal(doc: DeliveryDoc | null, run: RunRecord, items: PersonalItem[], now: Date): { doc: DeliveryDoc; changed: boolean; claimed: (PersonalItem & { payload: PushPayload })[] } {
  const d: DeliveryDoc = doc ?? { version: 1, digests: [] };
  const claimed: (PersonalItem & { payload: PushPayload })[] = [];
  const added: DigestRecord[] = [];
  for (const it of items) {
    const key = personalKey(run.runId, it.deviceId);
    if (d.digests.some((x) => x.runId === key)) continue;
    const sent = notifiedFor(d, it.deviceId);
    const events = it.events.filter((e) => !sent.has(e.id));
    const payload = digestPayload(run, events, it.gaps);
    if (!payload) continue;
    added.push({ runId: key, createdAt: now.toISOString(), eventIds: events.map((e) => e.id), payload, deviceId: it.deviceId, events: events.slice(0, 20), gaps: it.gaps, recipients: { [it.deviceId]: { status: "claimed", at: now.toISOString() } } });
    claimed.push({ ...it, events, payload });
  }
  if (!added.length) return { doc: d, changed: false, claimed };
  return { doc: { ...d, digests: prune([...added, ...d.digests], now) }, changed: true, claimed };
}
