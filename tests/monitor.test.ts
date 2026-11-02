import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyRun, emptyState, filingWindow, monitorHealth, sessionStatus, signalEvents, statusOf, type MonitorState } from "../src/lib/domain/monitor";
import { evaluateSignals } from "../src/lib/domain/metrics";
import type { Bar, RawAnnouncement } from "../src/lib/domain/types";
import { cronAuthorised } from "../src/lib/monitor/auth";
import { runScan, type MonitorStore, type ScanDeps } from "../src/lib/monitor/run";

const RULE = { pricePct: 4, volumeMultiple: 2 };
const T0 = Date.parse("2026-10-30T12:30:00Z"); // Friday 18:00 IST

/** Backing text outlives any store object, like the blob outlives an instance. Holds JSON so nothing is shared by reference. */
const memory = () => {
  const disk = { json: null as string | null, version: 0, writes: 0, conflictOnce: false };
  const store = (): MonitorStore => ({
    async read() { return disk.json ? { state: JSON.parse(disk.json) as MonitorState, etag: String(disk.version) } : null; },
    async write(state, etag) {
      if (disk.conflictOnce) { disk.conflictOnce = false; disk.version++; return false; }
      if (disk.json && etag !== String(disk.version)) return false;
      disk.json = JSON.stringify(state); disk.version++; disk.writes++;
      return true;
    },
  });
  return { disk, store };
};

const bars = (lastDate = "2026-10-30", lastClose = 110, lastVol = 300): Bar[] => {
  const out: Bar[] = Array.from({ length: 25 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, "0")}`, close: 100, volume: 100 }));
  out.push({ date: lastDate, close: lastClose, volume: lastVol });
  return out;
};
const filing = (seqId: string, symbol = "AAA", desc = "Outcome of Board Meeting", at = "2026-10-30T10:00:00+05:30"): RawAnnouncement => ({
  symbol, company: `${symbol} Ltd`, desc, text: `${symbol} has informed the Exchange about financial results for the quarter`, at, url: `https://nsearchives.nseindia.com/${seqId}.pdf`, seqId,
});
const deps = (store: MonitorStore, over: Partial<ScanDeps> = {}): ScanDeps => ({
  store, symbols: ["AAA", "BBB"], rule: RULE, now: () => T0, retryDelayMs: 0,
  fetchFilings: async () => [filing("1"), filing("9", "OTHER")],
  fetchBars: async () => bars(),
  ...over,
});
const finished = async (d: ScanDeps) => {
  const r = await runScan(d, "manual");
  if (r.outcome !== "finished") throw new Error("expected a finished run");
  return r.run;
};

describe("cron authorisation", () => {
  it("accepts only the exact bearer secret", () => {
    expect(cronAuthorised("Bearer s3cret", "s3cret")).toBe(true);
    for (const h of [null, "", "s3cret", "Bearer wrong", "bearer s3cret", "Bearer s3cret "]) expect(cronAuthorised(h, "s3cret")).toBe(false);
  });
  it("fails closed when no secret is configured", () => {
    for (const s of [undefined, ""]) {
      expect(cronAuthorised("Bearer ", s)).toBe(false);
      expect(cronAuthorised("Bearer undefined", s)).toBe(false);
    }
  });
});

describe("scheduled scan", () => {
  it("completes and records exactly what it checked", async () => {
    const m = memory();
    const run = await finished(deps(m.store()));
    expect(run).toMatchObject({ status: "success", companiesChecked: 2, filingsChecked: 1, latestSession: "2026-10-30", sessionStatus: "traded_today" });
    const s = (await m.store().read(true))!.state;
    expect(s.lastSuccess?.runId).toBe(run.runId);
    expect(s.current).toBeNull();
    expect(s.events.some((e) => e.symbol === "OTHER")).toBe(false);
  });
  it("adds nothing when repeated, and survives a fresh instance", async () => {
    const m = memory();
    const first = await finished(deps(m.store()));
    expect(first.newEvents).toBe(5); // one filing, plus price and volume for two companies
    const ids = (await m.store().read(true))!.state.events.map((e) => e.id).sort();
    const again = await finished(deps(m.store(), { now: () => T0 + 3600e3 }));
    expect(again.newEvents).toBe(0);
    expect((await m.store().read(true))!.state.events.map((e) => e.id).sort()).toEqual(ids);
  });
  it("keeps deduplicating a filing absorbed under another", async () => {
    const m = memory();
    const pair = [filing("1"), filing("2", "AAA", "Investor Presentation")];
    await finished(deps(m.store(), { fetchFilings: async () => pair }));
    const lead = (await m.store().read(true))!.state.events.filter((e) => e.kind === "filing");
    expect(lead).toHaveLength(1);
    const again = await finished(deps(m.store(), { fetchFilings: async () => pair, now: () => T0 + 60e6 }));
    expect(again.newEvents).toBe(0);
  });
  it("persists a new filing and marks it as news, not baseline", async () => {
    const m = memory();
    await finished(deps(m.store()));
    const run = await finished(deps(m.store(), { now: () => T0 + 86400e3, fetchFilings: async () => [filing("1"), filing("5", "BBB", "Acquisition", "2026-10-31T09:00:00+05:30")] }));
    expect(run.newEvents).toBe(1);
    const e = (await m.store().read(true))!.state.events.find((x) => x.seqId === "5")!;
    expect(e).toMatchObject({ baseline: false, category: "M&A", url: "https://nsearchives.nseindia.com/5.pdf", at: "2026-10-31T09:00:00+05:30" });
    expect((await m.store().read(true))!.state.events.find((x) => x.seqId === "1")!.baseline).toBe(true);
  });
  it("stores no filing body", async () => {
    const m = memory();
    const long = { ...filing("1"), text: `has informed the Exchange ${"SECRETWORD ".repeat(500)}` };
    await finished(deps(m.store(), { fetchFilings: async () => [long] }));
    expect(m.disk.json!.length).toBeLessThan(6000);
  });
  it("records prices as the app's own calculation does", async () => {
    const b = bars();
    const app = evaluateSignals(b, RULE, 5);
    const events = signalEvents("AAA", b, RULE, new Date(T0).toISOString(), false);
    expect(events.map((e) => [e.kind, e.value, e.close, e.session])).toEqual(app.map((e) => [e.type, e.value, e.close, e.date]));
    expect(events.find((e) => e.kind === "price")!.value).toBe(10);
    expect(events.find((e) => e.kind === "volume")!.value).toBe(3);
  });
  it("calls missing prices partial, never success, and names them", async () => {
    const m = memory();
    const run = await finished(deps(m.store(), { fetchBars: async (s) => { if (s === "BBB") throw new Error("yahoo responded 500"); return bars(); } }));
    expect(run.status).toBe("partial");
    expect(run.companiesFailed).toEqual(["BBB"]);
    const s = (await m.store().read(true))!.state;
    expect(s.lastSuccess).toBeNull();
    expect(s.signalsScannedAt).toBeNull();
    expect(run.errors.join()).toContain("BBB");
  });
  it("treats an empty bar list as missing data, not as no signal", async () => {
    const m = memory();
    expect((await finished(deps(m.store(), { fetchBars: async () => [] }))).status).toBe("partial");
  });
  it("calls an outage of every source failed, and keeps the earlier good scan and events", async () => {
    const m = memory();
    const good = await finished(deps(m.store()));
    const down = async () => { throw new Error("down"); };
    const bad = await finished(deps(m.store(), { fetchFilings: down, fetchBars: down, now: () => T0 + 86400e3 }));
    expect(bad).toMatchObject({ status: "failed", filingsChecked: null, companiesChecked: 0, sessionStatus: "unavailable" });
    const s = (await m.store().read(true))!.state;
    expect(s.lastRun?.status).toBe("failed");
    expect(s.lastSuccess?.runId).toBe(good.runId);
    expect(s.events.length).toBe(5);
  });
  it("does not trust an empty market-wide filings response", async () => {
    const m = memory();
    const run = await finished(deps(m.store(), { fetchFilings: async () => [] }));
    expect(run).toMatchObject({ status: "partial", filingsChecked: null });
  });
  it("distinguishes a company with no filings from an unread source", async () => {
    const m = memory();
    expect(await finished(deps(m.store(), { fetchFilings: async () => [filing("9", "OTHER")] }))).toMatchObject({ status: "success", filingsChecked: 0 });
  });
  it("marks a company behind the latest session as partial", async () => {
    const m = memory();
    const run = await finished(deps(m.store(), { fetchBars: async (s) => (s === "BBB" ? bars("2026-10-29") : bars()) }));
    expect(run).toMatchObject({ status: "partial", companiesLagging: ["BBB"] });
  });
  it("on a weekend scans successfully and repeats no session's signals", async () => {
    const m = memory();
    await finished(deps(m.store()));
    const saturday = Date.parse("2026-10-31T12:30:00Z");
    const run = await finished(deps(m.store(), { now: () => saturday }));
    expect(run).toMatchObject({ status: "success", latestSession: "2026-10-30", sessionStatus: "weekend", newEvents: 0 });
  });
  it("skips a duplicate invocation while one is running, but not after a crash", async () => {
    const m = memory();
    const s = m.store();
    await s.write({ ...emptyState(), current: { runId: "x", trigger: "cron", startedAt: new Date(T0 - 60e3).toISOString() } }, null);
    expect((await runScan(deps(s), "cron")).outcome).toBe("skipped");
    await s.write({ ...emptyState(), current: { runId: "x", trigger: "cron", startedAt: new Date(T0 - 600e3).toISOString() } }, String(m.disk.version));
    expect((await runScan(deps(s), "cron")).outcome).toBe("finished");
  });
  it("two overlapping runs both land without duplicates", async () => {
    const m = memory();
    await finished(deps(m.store()));
    m.disk.conflictOnce = true;
    expect((await finished(deps(m.store(), { now: () => T0 + 86400e3 }))).newEvents).toBe(0);
    const s = (await m.store().read(true))!.state;
    expect(new Set(s.events.map((e) => e.id)).size).toBe(s.events.length);
    expect(s.runs).toHaveLength(2);
  });
  it("applying the same run twice changes nothing", () => {
    const run = { runId: "r", trigger: "manual" as const, startedAt: new Date(T0).toISOString(), finishedAt: null, status: "success" as const, companiesExpected: 1, companiesChecked: 1, companiesFailed: [], companiesLagging: [], filingsChecked: 0, windowFrom: null, windowTo: null, latestSession: null, sessionStatus: "unavailable" as const, newEvents: 0, errors: [] };
    const ev = signalEvents("AAA", bars(), RULE, run.startedAt, false);
    const one = applyRun(emptyState(), run, ev, { filings: true, signals: true }).state;
    const two = applyRun(one, run, ev, { filings: true, signals: true });
    expect(two.added).toBe(0);
    expect(two.state.events).toEqual(one.events);
    expect(two.state.runs).toHaveLength(1);
  });
  it("only a cron run counts as automatic", async () => {
    const m = memory();
    await finished(deps(m.store()));
    expect((await m.store().read(true))!.state.lastAutomatic).toBeNull();
    await runScan(deps(m.store(), { now: () => T0 + 60e6 }), "cron");
    expect((await m.store().read(true))!.state.lastAutomatic?.trigger).toBe("cron");
  });
  it("surfaces a store failure instead of reporting a result", async () => {
    await expect(runScan(deps({ read: async () => { throw new Error("store down"); }, write: async () => true }), "cron")).rejects.toThrow();
  });
});

describe("monitor rules", () => {
  it("catches up after missed days, within limits", () => {
    expect(filingWindow(null, T0)).toEqual({ from: "2026-10-23", to: "2026-10-30" });
    expect(filingWindow(new Date(T0 - 86400e3).toISOString(), T0).from).toBe("2026-10-27");
    expect(filingWindow(new Date(T0 - 5 * 86400e3).toISOString(), T0).from).toBe("2026-10-23");
  });
  it("does not call a weekday with no bars a holiday", () => {
    expect(sessionStatus("2026-10-29", T0)).toBe("no_bars_today");
    expect(sessionStatus("2026-10-29", Date.parse("2026-10-30T05:00:00Z"))).toBe("not_closed_yet");
    expect(sessionStatus(null, T0)).toBe("unavailable");
  });
  it("success requires every source", () => {
    expect(statusOf(true, 19, 19, 0, 0)).toBe("success");
    expect(statusOf(false, 19, 19, 0, 0)).toBe("partial");
    expect(statusOf(true, 19, 0, 19, 0)).toBe("partial");
    expect(statusOf(false, 19, 0, 19, 0)).toBe("failed");
  });
  it("flags stale and stuck states", () => {
    expect(monitorHealth(null, T0)).toEqual({ stale: true, stuck: false });
    const s = { ...emptyState(), lastSuccess: { startedAt: new Date(T0 - 37 * 3600e3).toISOString() } as MonitorState["lastSuccess"], current: { runId: "x", trigger: "cron" as const, startedAt: new Date(T0 - 600e3).toISOString() } };
    expect(monitorHealth(s, T0)).toEqual({ stale: true, stuck: true });
  });
  it("is scheduled once daily within Hobby limits, after the close", () => {
    const cfg = JSON.parse(readFileSync("vercel.json", "utf8"));
    expect(cfg.crons).toEqual([{ path: "/api/cron/monitor", schedule: "0 12 * * *" }]);
    expect(cfg.regions).toEqual(["bom1"]);
  });
});
