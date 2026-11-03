import type { MonitorEvent, RunRecord } from "../domain/monitor";
import { claim, claimPersonal, digestPayload, eligible, notePersonalRun, notifiedFor, personalKey, qualifying, record, type DeliveryDoc, type PersonalItem } from "./digest";
import { matchDevice, type ScanData } from "./personal";
import { deliver, type Transport, type VapidConfig } from "./send";
import { mutate, type DocStore } from "./store";
import { remove, type PushDoc } from "./subscription";

export interface NotifyDeps {
  subs: DocStore<PushDoc>;
  deliveries: DocStore<DeliveryDoc>;
  vapid: VapidConfig | null;
  transport?: Transport;
  now?: () => number;
  /** No new batch is claimed after this long, so the cron function finishes inside its limit. */
  budgetMs?: number;
  batch?: number;
  concurrency?: number;
}

export interface NotifyReport {
  status: "nothing_new" | "not_configured" | "no_subscribers" | "done" | "partial";
  events: number;
  eligible: number;
  sent: number;
  failed: number;
  expired: number;
  /** Devices that should have received this digest but were not attempted before the time budget ran out. */
  notAttempted: number;
}

/**
 * Runs after a scan's results are saved. Policy: at most once per device per run. A device is claimed in the
 * delivery ledger (conditional write) before its send, and a claimed device is never sent again, even if the send
 * timed out or this function died before recording the result. That can miss a notification; it can't repeat one.
 */
export async function notifyRun(run: RunRecord, added: MonitorEvent[], deps: NotifyDeps): Promise<NotifyReport> {
  const { subs, deliveries, vapid, transport, now = Date.now, budgetMs = 40e3, batch = 50, concurrency = 10 } = deps;
  const start = now();
  const events = qualifying(run, added);
  const report: NotifyReport = { status: "nothing_new", events: events.length, eligible: 0, sent: 0, failed: 0, expired: 0, notAttempted: 0 };
  const payload = digestPayload(run, events);
  if (!payload) return report;
  if (!vapid) return { ...report, status: "not_configured" };

  const recipients = eligible((await subs.read())?.doc.subscriptions ?? [], run);
  report.eligible = recipients.length;
  const byId = new Map(recipients.map((r) => [r.id, r]));
  const digest = { runId: run.runId, createdAt: new Date(start).toISOString(), eventIds: events.map((e) => e.id), payload };
  if (!recipients.length) {
    await mutate(deliveries, (d) => claim(d, digest, [], new Date(now()), 0));
    return { ...report, status: "no_subscribers" };
  }

  for (;;) {
    if (now() - start > budgetMs) break;
    const c = await mutate(deliveries, (d) => claim(d, digest, [...byId.keys()], new Date(now()), batch));
    if (!c.claimed.length) break;
    const results = await deliver(c.claimed.map((id) => byId.get(id)!), payload, vapid, transport, concurrency);
    for (const id of c.claimed) byId.delete(id);
    await mutate(deliveries, (d) => record(d, run.runId, results, new Date(now())));
    for (const r of results) report[r.status === "sent" ? "sent" : r.status === "expired" ? "expired" : "failed"]++;
    for (const r of results.filter((x) => x.status === "expired")) await mutate(subs, (d) => remove(d, r.id)).catch(() => {});
  }
  // Anything left was claimed by a concurrent invocation (already handled) or not reached in time.
  const ledger = (await deliveries.read())?.doc.digests.find((d) => d.runId === run.runId);
  report.notAttempted = [...byId.keys()].filter((id) => !ledger?.recipients[id]).length;
  report.status = report.notAttempted ? "partial" : "done";
  return report;
}

export interface PersonalReport {
  status: "none_enabled" | "not_configured" | "done" | "partial";
  devices: number;
  matched: number;
  sent: number;
  failed: number;
  expired: number;
  notAttempted: number;
  /** Selected companies whose prices could not be read this run; filings unread is reported separately. */
  unchecked: string[];
  filingsRead: boolean;
}

/**
 * Personal rules, after the shared digest. Each device is matched on its own symbols, thresholds and filing types,
 * from data read once for everyone. Same at-most-once policy: claim, then send, never re-send.
 */
export async function notifyPersonal(run: RunRecord, data: ScanData, deps: NotifyDeps): Promise<PersonalReport> {
  const { subs, deliveries, vapid, transport, now = Date.now, budgetMs = 40e3, concurrency = 10 } = deps;
  const start = now();
  const devices = ((await subs.read())?.doc.subscriptions ?? []).filter((s) => s.personal?.on);
  const unchecked = [...new Set(devices.flatMap((d) => d.personal!.symbols).filter((s) => !data.bars.get(s)?.length))];
  const report: PersonalReport = { status: "none_enabled", devices: devices.length, matched: 0, sent: 0, failed: 0, expired: 0, notAttempted: 0, unchecked, filingsRead: data.filings != null };
  if (!devices.length) return report;
  await mutate(deliveries, (doc) => notePersonalRun(doc, { runId: run.runId, startedAt: run.startedAt, runStatus: run.status, filingsRead: report.filingsRead, unchecked }));
  // A failed scan read nothing usable; it is recorded above as failed, never as "no alerts".
  if (run.status === "failed") return { ...report, status: "done" };
  if (!vapid) return { ...report, status: "not_configured" };

  const ledger = (await deliveries.read())?.doc ?? null;
  const items: PersonalItem[] = [];
  for (const d of devices) {
    const m = matchDevice(d.personal!, data, notifiedFor(ledger, d.id));
    if (m.events.length) items.push({ deviceId: d.id, events: m.events, gaps: { unchecked: m.unchecked, filingsRead: m.filingsRead } });
  }
  report.matched = items.length;
  if (!items.length) return { ...report, status: "done" };

  const c = await mutate(deliveries, (doc) => claimPersonal(doc, run, items, new Date(now())));
  const byId = new Map(devices.map((d) => [d.id, d]));
  const queue = c.claimed.slice();
  const results: { key: string; id: string; status: "sent" | "failed" | "expired"; code?: number }[] = [];
  const worker = async () => {
    for (let it = queue.shift(); it; it = queue.shift()) {
      if (now() - start > budgetMs) {
        report.notAttempted++;
        results.push({ key: personalKey(run.runId, it.deviceId), id: it.deviceId, status: "failed" });
        continue;
      }
      const [r] = await deliver([byId.get(it.deviceId)!], it.payload, vapid, transport, 1);
      results.push({ key: personalKey(run.runId, it.deviceId), id: it.deviceId, status: r.status, code: r.code });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  await mutate(deliveries, (doc) => {
    let d = doc;
    let changed = false;
    for (const r of results) {
      const out = record(d, r.key, [r], new Date(now()));
      d = out.doc;
      changed ||= out.changed;
    }
    return { doc: d ?? { version: 1 as const, digests: [] }, changed };
  });
  for (const r of results) {
    if (r.status === "sent") report.sent++;
    else if (r.status === "expired") report.expired++;
    else report.failed++;
  }
  for (const r of results.filter((x) => x.status === "expired")) await mutate(subs, (d) => remove(d, r.id)).catch(() => {});
  report.failed -= report.notAttempted;
  report.status = report.notAttempted ? "partial" : "done";
  return report;
}
