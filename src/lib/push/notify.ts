import type { MonitorEvent, RunRecord } from "../domain/monitor";
import { claim, digestPayload, eligible, qualifying, record, type DeliveryDoc } from "./digest";
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
