import { createECDH } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { RunRecord } from "../src/lib/domain/monitor";
import type { Bar, RawAnnouncement } from "../src/lib/domain/types";
import { eligible, type DeliveryDoc } from "../src/lib/push/digest";
import { notifyPersonal, type NotifyDeps } from "../src/lib/push/notify";
import { extraSymbols, LIMITS, matchDevice, parseConfig, setPersonal, testBars, type PersonalConfig, type ScanData } from "../src/lib/push/personal";
import type { Transport } from "../src/lib/push/send";
import { mutate, type DocStore } from "../src/lib/push/store";
import { pushId, safePath, type PushDoc, type PushRecord } from "../src/lib/push/subscription";

vi.spyOn(console, "log").mockImplementation(() => {});

const RUN1 = "2026-11-03T12:00:00.000Z"; // 17:30 IST
const RUN2 = "2026-11-04T12:00:00.000Z";
const SHARED = ["LT", "KEI"];

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

const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const cfg = (over: Partial<PersonalConfig> = {}): PersonalConfig => ({
  on: true, symbols: ["ACME"], pricePct: 2, volumeMultiple: 3, categories: ["results"], updatedAt: "2026-11-01T00:00:00Z", effectiveFrom: "2026-11-01T00:00:00Z", ...over,
});
const device = (n: number, personal?: PersonalConfig): PushRecord => {
  const endpoint = `https://fcm.googleapis.com/fcm/send/p${n}`;
  return { id: pushId(endpoint), endpoint, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: `auth${n}aaaaaaaaaaaaaaaa` }, createdAt: "2026-10-01T00:00:00Z", ...(personal ? { personal } : {}) };
};
const run = (startedAt = RUN1, status: RunRecord["status"] = "success") => ({ runId: `run-${startedAt}`, startedAt, status }) as RunRecord;

/** 25 quiet sessions, then the given session closing `move`% up on `vol`× volume. */
const bars = (session: string, move: number, vol = 1): Bar[] => [
  ...Array.from({ length: 25 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, "0")}`, close: 100, volume: 1000 })),
  { date: session, close: 100 * (1 + move / 100), volume: 1000 * vol },
];
const filing = (seqId: string, at: string, symbol = "ACME", desc = "Outcome of Board Meeting", text = "ACME has informed the Exchange about financial results for the quarter"): RawAnnouncement => ({
  symbol, company: `${symbol} Ltd`, desc, text, at, url: `https://nsearchives.nseindia.com/${seqId}.pdf`, seqId,
});
const data = (over: Partial<ScanData> = {}): ScanData => ({ startedAt: RUN1, filings: [], bars: new Map([["ACME", bars("2026-11-03", 3)]]), ...over });

function harness(devices: PushRecord[]) {
  const subs = mem<PushDoc>({ version: 1, subscriptions: devices });
  const ledger = mem<DeliveryDoc>();
  const sent: { id: string; payload: { title: string; body: string; url: string } }[] = [];
  const transport: Transport = async (rec, body) => { sent.push({ id: rec.id, payload: JSON.parse(body) }); return 201; };
  const deps: NotifyDeps = { subs: subs.store, deliveries: ledger.store, vapid: { publicKey: "p", privateKey: "s", subject: "x" }, transport, now: () => Date.parse(RUN1) };
  return { subs, ledger, sent, deps };
}

describe("per-device matching", () => {
  it("two devices with different thresholds get different events", async () => {
    const tight = device(1, cfg({ pricePct: 2 }));
    const loose = device(2, cfg({ pricePct: 4 }));
    const h = harness([tight, loose]);
    const r = await notifyPersonal(run(), data(), h.deps);
    expect(r).toMatchObject({ devices: 2, matched: 1, sent: 1 });
    expect(h.sent.map((s) => s.id)).toEqual([tight.id]);
    expect(h.sent[0].payload.title).toBe("FINN: ACME closed +3.0%");
    expect(h.sent[0].payload.body).toMatch(/beyond your ±2% rule/);
    expect(h.sent[0].payload.url).toBe("/research/ACME");
  });

  it("a 3× volume rule ignores a 2.5× session; a company outside the portfolio never alerts", () => {
    const d = data({ bars: new Map([["ACME", bars("2026-11-03", 0, 2.5)], ["OTHER", bars("2026-11-03", 9)]]) });
    expect(matchDevice(cfg({ volumeMultiple: 3 }), d, new Set()).events).toEqual([]);
    expect(matchDevice(cfg({ volumeMultiple: 2 }), d, new Set()).events.map((e) => e.kind)).toEqual(["volume"]);
  });

  it("applies filing-type choices, and never sends routine filings", () => {
    const d = data({ bars: new Map([["ACME", bars("2026-11-03", 0)]]), filings: [filing("1", "2026-11-03T11:00:00+05:30"), filing("2", "2026-11-03T12:00:00+05:30", "ACME", "Trading Window", "Closure of trading window")] });
    expect(matchDevice(cfg({ categories: ["results"] }), d, new Set()).events.map((e) => e.id)).toEqual(["f:1"]);
    expect(matchDevice(cfg({ categories: ["M&A"] }), d, new Set()).events).toEqual([]);
    expect(matchDevice(cfg({ categories: ["results", "postal_ballot", "insider_trading"] }), d, new Set()).events.every((e) => e.priority !== "routine")).toBe(true);
  });

  it("opted-out and unsubscribed devices receive nothing", async () => {
    const off = device(1, cfg({ on: false }));
    const h = harness([off, device(2)]);
    expect(await notifyPersonal(run(), data(), h.deps)).toMatchObject({ status: "none_enabled", devices: 0 });
    expect(h.sent).toHaveLength(0);
  });

  it("a personal device is left out of the shared digest, so a phone never gets both", () => {
    const shared = { ...device(1), daily: { on: true, since: "2026-10-01T00:00:00Z" } };
    const mine = { ...device(2, cfg()), daily: { on: true, since: "2026-10-01T00:00:00Z" } };
    expect(eligible([shared, mine], run()).map((d) => d.id)).toEqual([shared.id]);
  });
});

describe("history and duplicates", () => {
  it("events before the rules took effect never qualify (portfolio changes count from then on)", () => {
    const d = data({ filings: [filing("1", "2026-11-03T11:00:00+05:30")] });
    const savedAfter = cfg({ effectiveFrom: "2026-11-03T11:30:00+05:30" });
    // The filing at 11:00 IST predates the save; today's session closes at 15:30 IST, after it.
    expect(matchDevice(savedAfter, d, new Set()).events.map((e) => e.id)).toEqual(["s:ACME:2026-11-03:price"]);
    expect(matchDevice(cfg({ effectiveFrom: "2026-11-03T16:00:00+05:30" }), d, new Set()).events).toEqual([]);
  });

  it("changing a threshold restarts the effective time, so old signals are not replayed", () => {
    const doc: PushDoc = { version: 1, subscriptions: [device(1, cfg({ pricePct: 4 }))] };
    const r = doc.subscriptions[0];
    const later = new Date("2026-11-03T13:00:00Z"); // 18:30 IST, after the 15:30 close
    const out = setPersonal(doc, r.endpoint, r.keys.auth, parseConfig({ symbols: ["ACME"], pricePct: 2, volumeMultiple: 3, categories: ["results"] }), SHARED, later);
    expect(out.config?.effectiveFrom).toBe(later.toISOString());
    expect(matchDevice(out.config!, data({ startedAt: RUN2 }), new Set()).events).toEqual([]);
  });

  it("a repeated or later scan does not resend an event already sent to that device", async () => {
    const h = harness([device(1, cfg())]);
    await notifyPersonal(run(RUN1), data(), h.deps);
    await notifyPersonal(run(RUN1), data(), h.deps); // same run invoked twice
    await notifyPersonal(run(RUN2), data({ startedAt: RUN2 }), { ...h.deps, now: () => Date.parse(RUN2) }); // next day still sees that session
    expect(h.sent).toHaveLength(1);
  });

  it("two scans racing never both send the same event to the same device", async () => {
    const h = harness([device(1, cfg())]);
    await Promise.all([notifyPersonal(run(RUN1), data(), h.deps), notifyPersonal(run(RUN2), data({ startedAt: RUN1 }), h.deps)]);
    expect(h.sent).toHaveLength(1);
  });

  it("a failed source read is reported, never treated as zero alerts", async () => {
    const h = harness([device(1, cfg({ symbols: ["ACME", "GONE"] }))]);
    const r = await notifyPersonal(run(RUN1, "partial"), data({ filings: null, bars: new Map([["ACME", bars("2026-11-03", 3)], ["GONE", null]]) }), h.deps);
    expect(r).toMatchObject({ filingsRead: false, unchecked: ["GONE"], sent: 1 });
    expect(h.sent[0].payload.body).toMatch(/Scan incomplete: filings not read; no prices for GONE\./);
    expect(h.ledger.get()!.personalRuns![0]).toMatchObject({ filingsRead: false, unchecked: ["GONE"], runStatus: "partial" });

    const failed = harness([device(2, cfg())]);
    expect(await notifyPersonal(run(RUN1, "failed"), data(), failed.deps)).toMatchObject({ sent: 0 });
    expect(failed.ledger.get()!.personalRuns![0].runStatus).toBe("failed");
  });
});

describe("settings", () => {
  const owner = device(1);
  const base = () => ({ version: 1 as const, subscriptions: [owner, device(2)] });
  const good = { symbols: ["ACME", "LT"], pricePct: 2, volumeMultiple: 3, categories: ["results"] };

  it("rejects invalid symbols and out-of-range or malformed values", () => {
    for (const bad of [
      null, {}, { ...good, symbols: [] }, { ...good, symbols: ["lt"] }, { ...good, symbols: ["L T"] }, { ...good, symbols: ["<script>"] },
      { ...good, pricePct: 0 }, { ...good, pricePct: 51 }, { ...good, pricePct: "2" }, { ...good, pricePct: NaN }, { ...good, volumeMultiple: 1 },
      { ...good, categories: ["unclassified"] }, { ...good, categories: ["bogus"] }, { ...good, symbols: Array.from({ length: 26 }, (_, i) => `S${i}`) },
    ]) expect(parseConfig(bad).ok, JSON.stringify(bad)).toBe(false);
    expect(parseConfig(good)).toMatchObject({ ok: true, value: { symbols: ["ACME", "LT"] } });
  });

  it("can only be changed with the device's own endpoint and secret, and leaves other devices alone", () => {
    const parsed = parseConfig(good);
    expect(setPersonal(base(), owner.endpoint, "wrong", parsed, SHARED, new Date()).result).toBe("absent");
    expect(setPersonal(base(), device(9).endpoint, owner.keys.auth, parsed, SHARED, new Date()).result).toBe("absent");
    const ok = setPersonal(base(), owner.endpoint, owner.keys.auth, parsed, SHARED, new Date());
    expect(ok.result).toBe("saved");
    expect(ok.doc.subscriptions[1]).toEqual(device(2));
    const off = setPersonal(ok.doc, owner.endpoint, owner.keys.auth, null, SHARED, new Date());
    expect(off.config?.on).toBe(false);
  });

  it("concurrent updates from two devices both persist", async () => {
    const a = device(1), b = device(2);
    const m = mem<PushDoc>({ version: 1, subscriptions: [a, b] });
    await Promise.all([
      mutate(m.store, (d) => setPersonal(d, a.endpoint, a.keys.auth, parseConfig(good), SHARED, new Date())),
      mutate(m.store, (d) => setPersonal(d, b.endpoint, b.keys.auth, parseConfig({ ...good, pricePct: 5 }), SHARED, new Date())),
    ]);
    const [ra, rb] = m.get()!.subscriptions;
    expect([ra.personal?.pricePct, rb.personal?.pricePct]).toEqual([2, 5]);
  });

  it("caps the companies priced beyond the shared list, and the number of devices", () => {
    const many = (n: number, from: number) => Array.from({ length: n }, (_, i) => `X${from + i}`);
    const subs = Array.from({ length: 3 }, (_, i) => device(10 + i, cfg({ symbols: many(25, i * 25) })));
    expect(extraSymbols(subs, SHARED)).toHaveLength(75);
    const doc: PushDoc = { version: 1, subscriptions: [...subs.slice(0, 2), owner] };
    const r = setPersonal(doc, owner.endpoint, owner.keys.auth, parseConfig({ ...good, symbols: many(25, 100) }), SHARED, new Date());
    expect(r.result).toBe("full");
    // Shared symbols cost nothing extra, so a device using them still fits.
    expect(setPersonal(doc, owner.endpoint, owner.keys.auth, parseConfig({ ...good, symbols: SHARED }), SHARED, new Date()).result).toBe("saved");
    const full: PushDoc = { version: 1, subscriptions: [...Array.from({ length: LIMITS.devices }, (_, i) => device(100 + i, cfg({ symbols: ["LT"] }))), owner] };
    expect(setPersonal(full, owner.endpoint, owner.keys.auth, parseConfig(good), SHARED, new Date()).result).toBe("full");
  });
});

describe("admin synthetic test", () => {
  it("the same matcher accepts a move beyond the saved rule and rejects one inside it", () => {
    const now = new Date("2026-11-03T09:00:00Z");
    const d = (move: number): ScanData => ({ startedAt: now.toISOString(), filings: [], bars: new Map([["LT", testBars(move, now)]]) });
    const anytime = { effectiveFrom: new Date(0).toISOString() };
    expect(matchDevice(cfg({ symbols: ["LT"], pricePct: 2, ...anytime }), d(3), new Set()).events.map((e) => e.kind)).toEqual(["price"]);
    expect(matchDevice(cfg({ symbols: ["LT"], pricePct: 4, ...anytime }), d(3), new Set()).events).toEqual([]);
    expect(matchDevice(cfg({ symbols: ["KEI"], pricePct: 2, ...anytime }), d(3), new Set()).events).toEqual([]);
  });

  it("the multi-event target stays on FINN", () => {
    expect(safePath("/alerts#my-alerts")).toBe("/alerts#my-alerts");
    expect(safePath("/alerts#x")).toBe("/alerts");
  });
});

describe("runtime bounds", () => {
  it("50 personal devices with 25 companies each are matched and sent within budget", async () => {
    const symbols = Array.from({ length: 25 }, (_, i) => `S${i}`);
    const b = new Map<string, Bar[] | null>(symbols.map((s, i) => [s, bars("2026-11-03", i % 2 ? 5 : 0.5)]));
    const devices = Array.from({ length: LIMITS.devices }, (_, i) => device(i, cfg({ symbols, pricePct: 1 + (i % 4) })));
    const h = harness(devices);
    const t = Date.now();
    const r = await notifyPersonal(run(), { startedAt: RUN1, filings: [], bars: b }, h.deps);
    expect(Date.now() - t).toBeLessThan(5000);
    expect(r).toMatchObject({ devices: 50, matched: 50, sent: 50, notAttempted: 0 });
    expect(h.sent.every((s) => s.payload.url === "/alerts#my-alerts" && /signals in your portfolio/.test(s.payload.title))).toBe(true);
  });
});
