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
export function digestPayload(run: RunRecord, events: MonitorEvent[]): PushPayload | null {
  if (!events.length) return null;
  const partial = run.status === "partial" ? ` Scan incomplete: ${run.companiesChecked} of ${run.companiesExpected} companies read.` : "";
  const tag = `finn-daily-${run.runId.slice(0, 8)}`;
  if (events.length === 1) {
    const e = events[0];
    const url = safePath(`/research/${e.symbol}`);
    if (e.kind === "filing") {
      return { title: `FINN: ${e.symbol} filing`, body: clip(`${e.summary ?? "New important filing"}. Filed ${day(e.at)}.`, 150) + partial, url, tag };
    }
    if (e.kind === "price") {
      return { title: `FINN: ${e.symbol} closed ${sign(e.value ?? 0)}`, body: `End-of-day move on ${day(e.at)}, beyond the shared ±${e.threshold}% rule. Tap to review.${partial}`, url, tag };
    }
    return { title: `FINN: ${e.symbol} volume ${e.value}×`, body: `${e.value}× its prior 20-session average on ${day(e.at)}, above the shared ${e.threshold}× rule.${partial}`, url, tag };
  }
  const filings = events.filter((e) => e.kind === "filing").length;
  const moves = events.length - filings;
  const companies = [...new Set(events.map((e) => e.symbol))];
  const parts = [filings && plural(filings, "important filing", "important filings"), moves && plural(moves, "unusual EOD move", "unusual EOD moves")].filter(Boolean);
  const names = companies.length <= 3 ? companies.join(", ") : `${companies.slice(0, 3).join(", ")} and ${companies.length - 3} more`;
  return {
    title: `FINN: ${events.length} portfolio signals`,
    body: `${parts.join(" and ")} (${names}). Tap to review the evidence.${partial}`,
    url: "/alerts",
    tag,
  };
}

/** Consent given before this scan started. Turning alerts on later never reaches back to earlier scans. */
export const eligible = (subs: PushRecord[], run: RunRecord) =>
  subs.filter((s) => s.daily?.on && Date.parse(s.daily.since) <= Date.parse(run.startedAt));

// Delivery ledger: one record per run, one entry per device. An entry is claimed before the send and never re-sent.

export type Outcome = "claimed" | "sent" | "failed" | "expired";

export interface DigestRecord {
  runId: string;
  createdAt: string;
  eventIds: string[];
  payload: PushPayload;
  recipients: Record<string, { status: Outcome; at: string; code?: number }>;
}

export interface DeliveryDoc {
  version: 1;
  digests: DigestRecord[];
}

const KEEP_DIGESTS = 60;

export type Claim = { doc: DeliveryDoc; changed: boolean; claimed: string[] };

/** Claims up to `max` devices that no invocation has claimed for this run. The conditional write makes a claim exclusive. */
export function claim(doc: DeliveryDoc | null, digest: Omit<DigestRecord, "recipients">, ids: string[], now: Date, max: number): Claim {
  const d: DeliveryDoc = doc ?? { version: 1, digests: [] };
  const existing = d.digests.find((x) => x.runId === digest.runId);
  const rec: DigestRecord = existing ? { ...existing, recipients: { ...existing.recipients } } : { ...digest, recipients: {} };
  const claimed = ids.filter((id) => !rec.recipients[id]).slice(0, max);
  if (existing && !claimed.length) return { doc: d, changed: false, claimed };
  for (const id of claimed) rec.recipients[id] = { status: "claimed", at: now.toISOString() };
  const digests = [rec, ...d.digests.filter((x) => x.runId !== digest.runId)].slice(0, KEEP_DIGESTS);
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
