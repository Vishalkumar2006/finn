import { createECDH, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MonitorEvent, MonitorState, RunRecord } from "../src/lib/domain/monitor";
import type { Bar, RawAnnouncement } from "../src/lib/domain/types";
import { runScan, type MonitorStore, type ScanDeps } from "../src/lib/monitor/run";
import { claim, digestPayload, eligible, qualifying, type DeliveryDoc } from "../src/lib/push/digest";
import { notifyRun, type NotifyDeps } from "../src/lib/push/notify";
import type { Transport } from "../src/lib/push/send";
import type { DocStore } from "../src/lib/push/store";
import { pushId, setDaily, testPayload, upsert, type PushDoc, type PushRecord } from "../src/lib/push/subscription";

vi.spyOn(console, "log").mockImplementation(() => {});

const RULE = { pricePct: 4, volumeMultiple: 2 };
const DAY = 24 * 3600e3;
const T0 = Date.parse("2026-10-29T12:00:00Z"); // first scan, Thu 17:30 IST: everything already public is baseline
const T1 = T0 + DAY; // next day's scan

/** Compare-and-swap JSON store, the same contract as the Blob documents. */
function mem<D>(initial: D | null = null) {
  const disk = { json: initial ? JSON.stringify(initial) : null, v: 0 };
  const store: DocStore<D> = {
    async read() { return disk.json ? { doc: JSON.parse(disk.json) as D, etag: String(disk.v) } : null; },
    async write(doc, etag) {
      if ((etag === null && disk.json) || (etag !== null && etag !== String(disk.v))) return false;
      disk.json = JSON.stringify(doc); disk.v++;
      return true;
    },
  };
  return { store, get: () => (disk.json ? (JSON.parse(disk.json) as D) : null) };
}

function monitorMem() {
  const m = mem<MonitorState>();
  const store: MonitorStore = { read: async () => { const r = await m.store.read(); return r ? { state: r.doc, etag: r.etag } : null; }, write: (s, e) => m.store.write(s, e) };
  return { store, get: m.get };
}

const bars = (): Bar[] => [...Array.from({ length: 25 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, "0")}`, close: 100, volume: 100 })), { date: "2026-10-28", close: 100, volume: 100 }];
const filing = (seqId: string, at: string, desc = "Outcome of Board Meeting", text = "AAA has informed the Exchange about financial results for the quarter"): RawAnnouncement => ({
  symbol: "AAA", company: "AAA Ltd", desc, text, at, url: `https://nsearchives.nseindia.com/${seqId}.pdf`, seqId,
});
const scanDeps = (store: MonitorStore, now: number, filings: RawAnnouncement[]): ScanDeps => ({
  store, symbols: ["AAA", "BBB"], rule: RULE, now: () => now, retryDelayMs: 0, fetchFilings: async () => filings, fetchBars: async () => bars(),
});
async function scan(store: MonitorStore, now: number, filings: RawAnnouncement[]) {
  const r = await runScan(scanDeps(store, now, filings), "cron");
  if (r.outcome !== "finished") throw new Error("expected a finished run");
  return r;
}

const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const KEYS = { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") };
const device = (n: number, daily?: { on: boolean; since: string }): PushRecord => {
  const endpoint = `https://fcm.googleapis.com/fcm/send/dev${n}`;
  return { id: pushId(endpoint), endpoint, keys: KEYS, createdAt: "2026-10-01T00:00:00Z", ...(daily ? { daily } : {}) };
};
const OPTED = { on: true, since: "2026-10-01T00:00:00Z" };
const VAPID = { publicKey: "p", privateKey: "s", subject: "https://finn-delta-eight.vercel.app" };

function harness(devices: PushRecord[], transport?: Transport) {
  const subs = mem<PushDoc>({ version: 1, subscriptions: devices });
  const ledger = mem<DeliveryDoc>();
  const sent: { id: string; body: string }[] = [];
  const t: Transport = transport ?? (async (rec, body) => { sent.push({ id: rec.id, body }); return 201; });
  const deps: NotifyDeps = { subs: subs.store, deliveries: ledger.store, vapid: VAPID, transport: t, now: () => T1 };
  return { subs, ledger, sent, deps };
}

/** Day 1 baseline scan, then day 2 with whatever new filings are given. */
async function twoDays(newFilings: RawAnnouncement[]) {
  const m = monitorMem();
  const day1 = await scan(m.store, T0, [filing("100", "2026-10-29T10:00:00+05:30")]);
  const day2 = await scan(m.store, T1, [filing("100", "2026-10-29T10:00:00+05:30"), ...newFilings]);
  return { m, day1, day2 };
}

describe("which events qualify", () => {
  it("baseline events from the first scan send nothing", async () => {
    const { day1 } = await twoDays([]);
    expect(day1.added.length).toBeGreaterThan(0);
    expect(day1.added.every((e) => e.baseline)).toBe(true);
    const h = harness([device(1, OPTED)]);
    expect(await notifyRun(day1.run, day1.added, h.deps)).toMatchObject({ status: "nothing_new", events: 0 });
    expect(h.sent).toHaveLength(0);
  });

  it("one new material filing makes exactly one digest for an opted-in device, opening that company", async () => {
    const { day2 } = await twoDays([filing("200", "2026-10-30T11:00:00+05:30")]);
    expect(day2.added.map((e) => e.id)).toEqual(["f:200"]);
    const h = harness([device(1, OPTED)]);
    const r = await notifyRun(day2.run, day2.added, h.deps);
    expect(r).toMatchObject({ status: "done", events: 1, eligible: 1, sent: 1 });
    const p = JSON.parse(h.sent[0].body);
    expect(p.url).toBe("/research/AAA");
    expect(p.title).toBe("FINN: AAA filing");
    expect(h.ledger.get()!.digests[0]).toMatchObject({ runId: day2.run.runId, eventIds: ["f:200"] });
  });

  it("a routine filing sends nothing", async () => {
    const { day2 } = await twoDays([filing("300", "2026-10-30T11:00:00+05:30", "Trading Window", "Closure of trading window for designated persons")]);
    expect(day2.added).toHaveLength(1);
    expect(day2.added[0].priority).toBe("routine");
    const h = harness([device(1, OPTED)]);
    expect((await notifyRun(day2.run, day2.added, h.deps)).status).toBe("nothing_new");
    expect(h.sent).toHaveLength(0);
  });

  it("an event seen again in a later scan is not added, so it is never sent twice", async () => {
    const m = monitorMem();
    await scan(m.store, T0, [filing("100", "2026-10-29T10:00:00+05:30")]);
    const day2 = await scan(m.store, T1, [filing("200", "2026-10-30T11:00:00+05:30")]);
    const day3 = await scan(m.store, T1 + DAY, [filing("200", "2026-10-30T11:00:00+05:30")]);
    expect(day2.added).toHaveLength(1);
    expect(day3.added).toHaveLength(0);
    const h = harness([device(1, OPTED)]);
    await notifyRun(day2.run, day2.added, h.deps);
    await notifyRun(day3.run, day3.added, h.deps);
    expect(h.sent).toHaveLength(1);
  });

  it("old events stored earlier never qualify, even if passed in again", async () => {
    const { day1, day2 } = await twoDays([]);
    // Day 1's events handed to day 2's run: wrong detection time, and baseline.
    expect(qualifying(day2.run, day1.added)).toEqual([]);
  });

  it("a stale filing first seen late, a failed run and a future-dated event are excluded", () => {
    const run = { runId: "r", startedAt: new Date(T1).toISOString(), status: "success" } as RunRecord;
    const e = (at: string, over: Partial<MonitorEvent> = {}): MonitorEvent => ({ id: at, kind: "filing", symbol: "AAA", at, detectedAt: run.startedAt, baseline: false, priority: "critical", ...over });
    expect(qualifying(run, [e(new Date(T1 - 5 * DAY).toISOString())])).toEqual([]);
    expect(qualifying(run, [e(new Date(T1 + 3 * DAY).toISOString())])).toEqual([]);
    expect(qualifying({ ...run, status: "failed" }, [e(new Date(T1 - DAY).toISOString())])).toEqual([]);
    expect(qualifying(run, [e(new Date(T1 - 3 * DAY).toISOString())])).toHaveLength(1);
  });
});

describe("digest text", () => {
  const run = { runId: "abcdef12-0000", startedAt: "2026-10-30T12:00:00Z", status: "success", companiesChecked: 19, companiesExpected: 19 } as RunRecord;
  const ev = (kind: MonitorEvent["kind"], symbol: string, over: Partial<MonitorEvent> = {}): MonitorEvent =>
    ({ id: `${kind}${symbol}`, kind, symbol, at: "2026-10-30T10:00:00+05:30", detectedAt: run.startedAt, baseline: false, priority: "critical", summary: "Q2 results", value: 5.24, threshold: kind === "price" ? 4 : 2, ...over });

  it("uses the real counts and opens Alerts for several events", () => {
    const p = digestPayload(run, [ev("filing", "LT"), ev("filing", "KEI"), ev("price", "LT")])!;
    expect(p.title).toBe("FINN: 3 portfolio signals");
    expect(p.body).toBe("2 important filings and 1 unusual EOD move (LT, KEI). Tap to review the evidence.");
    expect(p.url).toBe("/alerts");
  });

  it("names the company for a single signal, and flags a partial scan", () => {
    expect(digestPayload(run, [ev("price", "LT", { value: -5.24 })])!.title).toBe("FINN: LT closed -5.2%");
    const partial = digestPayload({ ...run, status: "partial", companiesChecked: 17 }, [ev("volume", "KEI", { value: 2.6 })])!;
    expect(partial.title).toBe("FINN: KEI volume 2.6×");
    expect(partial.body).toMatch(/Scan incomplete: 17 of 19 companies read\.$/);
  });

  it("sends nothing on a quiet day", () => {
    expect(digestPayload(run, [])).toBeNull();
  });

  it("the admin format sample is labelled TEST, opens Alerts and names no company or figure", () => {
    const p = testPayload("/research/LT", new Date("2026-11-03T09:00:00Z"), "daily");
    expect(p.title).toMatch(/^TEST/);
    expect(p.body).toMatch(/^TEST sample sent at 14:30 IST, not real events/);
    expect(p.url).toBe("/alerts");
    expect(`${p.title} ${p.body}`).not.toMatch(/%|×|₹|\b(LT|KEI|SUPREMEIND)\b/);
  });
});

describe("consent", () => {
  const run = { runId: "r1", startedAt: "2026-10-30T12:00:00Z", status: "success" } as RunRecord;

  it("is off by default, off for opted-out devices, and never reaches back to an earlier scan", () => {
    const later = { on: true, since: "2026-10-30T12:00:01Z" };
    const ids = eligible([device(1), device(2, { on: false, since: "2026-10-01T00:00:00Z" }), device(3, later), device(4, OPTED)], run).map((d) => d.endpoint.slice(-4));
    expect(ids).toEqual(["dev4"]);
  });

  it("can be changed only with the device's own endpoint and auth secret, not its code", () => {
    const d = device(1);
    const doc: PushDoc = { version: 1, subscriptions: [d] };
    const now = new Date("2026-10-30T13:00:00Z");
    expect(setDaily(doc, d.endpoint, "wrong-secret", true, now).result).toBe("absent");
    expect(setDaily(doc, "https://fcm.googleapis.com/fcm/send/other", KEYS.auth, true, now).result).toBe("absent");
    const on = setDaily(doc, d.endpoint, KEYS.auth, true, now);
    expect(on.doc.subscriptions[0].daily).toEqual({ on: true, since: now.toISOString() });
    // Re-registering the device keeps the choice; turning alerts off keeps the subscription.
    expect(upsert(on.doc, { endpoint: d.endpoint, keys: KEYS }, now).doc.subscriptions[0].daily?.on).toBe(true);
    const off = setDaily(on.doc, d.endpoint, KEYS.auth, false, now);
    expect(off.doc.subscriptions).toHaveLength(1);
    expect(off.doc.subscriptions[0].daily?.on).toBe(false);
  });

  it("opted-out and late-consent devices receive nothing in a real run", async () => {
    const { day2 } = await twoDays([filing("200", "2026-10-30T11:00:00+05:30")]);
    const h = harness([device(1), device(2, { on: false, since: OPTED.since }), device(3, { on: true, since: new Date(T1 + 1000).toISOString() })]);
    expect(await notifyRun(day2.run, day2.added, h.deps)).toMatchObject({ status: "no_subscribers", sent: 0 });
    expect(h.sent).toHaveLength(0);
  });
});

describe("delivery ledger", () => {
  it("a retried notify for the same run sends nothing more", async () => {
    const { day2 } = await twoDays([filing("200", "2026-10-30T11:00:00+05:30")]);
    const h = harness([device(1, OPTED), device(2, OPTED)]);
    await notifyRun(day2.run, day2.added, h.deps);
    const again = await notifyRun(day2.run, day2.added, h.deps);
    expect(h.sent).toHaveLength(2);
    expect(again).toMatchObject({ sent: 0, notAttempted: 0, status: "done" });
  });

  it("two simultaneous invocations send each device exactly once", async () => {
    const { day2 } = await twoDays([filing("200", "2026-10-30T11:00:00+05:30")]);
    const devices = Array.from({ length: 30 }, (_, i) => device(i, OPTED));
    const h = harness(devices, async (rec, body) => { await new Promise((r) => setTimeout(r, 2)); h.sent.push({ id: rec.id, body }); return 201; });
    const [a, b] = await Promise.all([notifyRun(day2.run, day2.added, { ...h.deps, batch: 7 }), notifyRun(day2.run, day2.added, { ...h.deps, batch: 7 })]);
    expect(h.sent).toHaveLength(30);
    expect(new Set(h.sent.map((s) => s.id)).size).toBe(30);
    expect(a.sent + b.sent).toBe(30);
  });

  it("serves more than 50 devices in batches, and reports any not reached in time", async () => {
    const { day2 } = await twoDays([filing("200", "2026-10-30T11:00:00+05:30")]);
    const many = Array.from({ length: 120 }, (_, i) => device(i, OPTED));
    const h = harness(many);
    expect(await notifyRun(day2.run, day2.added, h.deps)).toMatchObject({ status: "done", eligible: 120, sent: 120 });

    let clock = T1;
    const slow = harness(many);
    const r = await notifyRun(day2.run, day2.added, { ...slow.deps, now: () => (clock += 15e3), budgetMs: 40e3 });
    expect(r.status).toBe("partial");
    expect(r.sent + r.notAttempted).toBe(120);
    expect(r.notAttempted).toBeGreaterThan(0);
  });

  it("removes expired subscriptions, records failures as failed, and never retries a failed send", async () => {
    const { day2 } = await twoDays([filing("200", "2026-10-30T11:00:00+05:30")]);
    const [gone, broken, fine] = [device(1, OPTED), device(2, OPTED), device(3, OPTED)];
    let calls = 0;
    const h = harness([gone, broken, fine], async (rec) => {
      calls++;
      if (rec.id === gone.id) throw Object.assign(new Error("gone"), { statusCode: 410 });
      if (rec.id === broken.id) throw Object.assign(new Error("boom"), { statusCode: 503 });
      return 201;
    });
    expect(await notifyRun(day2.run, day2.added, h.deps)).toMatchObject({ sent: 1, failed: 1, expired: 1 });
    expect(h.subs.get()!.subscriptions.map((s) => s.id)).toEqual([broken.id, fine.id]);
    const recips = h.ledger.get()!.digests[0].recipients;
    expect([recips[gone.id].status, recips[broken.id].status, recips[fine.id].status]).toEqual(["expired", "failed", "sent"]);
    await notifyRun(day2.run, day2.added, h.deps);
    expect(calls).toBe(3);
  });

  it("a claimed device whose result was never recorded (crash) is not sent again", () => {
    const digest = { runId: "r", createdAt: "x", eventIds: ["f:1"], payload: { title: "t", body: "b", url: "/alerts", tag: "t" } };
    const first = claim(null, digest, ["a", "b"], new Date(), 50);
    expect(first.claimed).toEqual(["a", "b"]);
    expect(claim(first.doc, digest, ["a", "b", "c"], new Date(), 50).claimed).toEqual(["c"]);
  });

  it("push failures never touch the saved monitoring state", async () => {
    const { m, day2 } = await twoDays([filing("200", "2026-10-30T11:00:00+05:30")]);
    const before = JSON.stringify(m.get());
    const h = harness([device(1, OPTED)]);
    const brokenLedger: DocStore<DeliveryDoc> = { read: async () => { throw new Error("blob down"); }, write: async () => false };
    await expect(notifyRun(day2.run, day2.added, { ...h.deps, deliveries: brokenLedger })).rejects.toThrow();
    expect(JSON.stringify(m.get())).toBe(before);
    expect(m.get()!.lastRun?.status).toBe("success");
    expect(h.sent).toHaveLength(0);
  });

  it("without VAPID keys nothing is attempted and the report says so", async () => {
    const { day2 } = await twoDays([filing("200", "2026-10-30T11:00:00+05:30")]);
    const h = harness([device(1, OPTED)]);
    expect((await notifyRun(day2.run, day2.added, { ...h.deps, vapid: null })).status).toBe("not_configured");
  });
});
