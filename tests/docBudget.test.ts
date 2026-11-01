import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { cached, backgroundWork, setRemoteStore, type RemoteStore } from "../src/lib/sources/http";
import { gatherDocs } from "../src/lib/research/engine";

type Doc = { name: string; pages: string[]; late?: boolean };
const doc = (name: string, ms: number, pages = ["text"]) =>
  new Promise<Doc>((res) => setTimeout(() => res({ name, pages }), ms));
const late = (i: number): Doc => ({ name: `late-${i}`, pages: [], late: true });

describe("gatherDocs", () => {
  it("answers without a slow report once its wait is over", async () => {
    const t = Date.now();
    const r = await gatherDocs([doc("t", 5)], [doc("ar", 2000)], late, 5000, 60);
    expect(Date.now() - t).toBeLessThan(1000);
    expect(r.map((d) => d.name)).toEqual(["t", "late-1"]);
  });
  it("includes a report that arrives within its wait", async () => {
    const r = await gatherDocs([doc("t", 5)], [doc("ar", 20)], late, 5000, 500);
    expect(r.map((d) => d.name)).toEqual(["t", "ar"]);
  });
  it("includes a report that is already read, even with no wait left", async () => {
    const r = await gatherDocs([doc("t", 50)], [Promise.resolve({ name: "ar", pages: ["x"] })], late, 5000, 0);
    expect(r.map((d) => d.name)).toEqual(["t", "ar"]);
  });
  it("waits the full budget for the report when no transcript is readable", async () => {
    const r = await gatherDocs([doc("t", 5, [])], [doc("ar", 150)], late, 5000, 10);
    expect(r.map((d) => d.name)).toEqual(["t", "ar"]);
  });
  it("waits the full budget when there are no transcripts at all", async () => {
    const r = await gatherDocs([], [doc("ar", 100)], late, 5000, 10);
    expect(r.map((d) => d.name)).toEqual(["ar"]);
  });
  it("keeps the old behaviour without a wait", async () => {
    const r = await gatherDocs([doc("t", 5)], [doc("ar", 100)], late, 5000);
    expect(r.map((d) => d.name)).toEqual(["t", "ar"]);
  });
  it("marks a transcript late at the overall budget", async () => {
    const r = await gatherDocs([doc("t", 3000)], [], late, 10, 1);
    expect(r[0].late).toBe(true);
  }, 3000);
  it("does not let one slow transcript hold the answer", async () => {
    const t = Date.now();
    const r = await gatherDocs([doc("fast", 5), doc("slow", 2000)], [doc("ar", 5)], late, 5000, 60);
    expect(Date.now() - t).toBeLessThan(1000);
    expect(r.map((d) => d.name)).toEqual(["fast", "late-1", "ar"]);
  });
});

describe("cache sharing between warm-up and question", () => {
  it("runs concurrent reads of one document once, and a late read finishes into the cache", async () => {
    const key = `test:dedupe:${Date.now()}`;
    let runs = 0;
    const work = () => new Promise<number>((res) => { runs++; setTimeout(() => res(7), 40); });
    const first = cached(key, 60e3, work);
    const second = cached(key, 60e3, work);
    expect((await Promise.all([first, second])).map((x) => x.value)).toEqual([7, 7]);
    expect(runs).toBe(1);
    expect((await cached(key, 60e3, work)).mode).toBe("cache");
    expect(runs).toBe(1);
  });
  it("backgroundWork waits for reads in progress and survives a failed one", async () => {
    const key = `test:bg:${Date.now()}`;
    let done = false;
    const p = cached(key, 60e3, () => new Promise<number>((res) => setTimeout(() => { done = true; res(1); }, 30)));
    const bad = cached(`${key}:bad`, 60e3, () => Promise.reject(new Error("down"))).catch(() => null);
    await backgroundWork();
    expect(done).toBe(true);
    await Promise.all([p, bad]);
  });
});

describe("shared store", () => {
  const fakeStore = () => {
    const items = new Map<string, unknown>();
    const store: RemoteStore = { get: async (k) => items.get(k) ?? null, set: async (k, v) => { items.set(k, v); } };
    return { items, store };
  };
  const packed = (at: number, value: unknown) => gzipSync(JSON.stringify({ at, value })).toString("base64");
  afterEach(() => setRemoteStore(null));
  const LONG = 2 * 3600e3;
  const uniq = (n: string) => `test:remote:${n}:${Date.now()}:${Math.random()}`;

  it("serves a value another instance stored, without calling the source", async () => {
    const { items, store } = fakeStore();
    setRemoteStore(store);
    const key = uniq("hit");
    items.set(key, packed(Date.now() - 1000, 42));
    const r = await cached(key, LONG, async () => { throw new Error("source must not be called"); });
    expect(r).toMatchObject({ value: 42, mode: "cache", stale: false });
  });
  it("refetches an expired shared value, and serves it as stale if the source is down", async () => {
    const { items, store } = fakeStore();
    setRemoteStore(store);
    const a = uniq("expired");
    items.set(a, packed(Date.now() - 2 * LONG, "old"));
    expect(await cached(a, LONG, async () => "new")).toMatchObject({ value: "new", mode: "live", stale: false });
    const b = uniq("outage");
    items.set(b, packed(Date.now() - 2 * LONG, "old"));
    expect(await cached(b, LONG, async () => { throw new Error("down"); })).toMatchObject({ value: "old", stale: true });
  });
  it("stores a fetched value, and skips short-lived data entirely", async () => {
    const { items, store } = fakeStore();
    setRemoteStore(store);
    const a = uniq("write");
    await cached(a, LONG, async () => 1);
    expect(items.has(a)).toBe(true);
    const b = uniq("short");
    await cached(b, 60e3, async () => 1);
    expect(items.has(b)).toBe(false);
  });
  it("skips an item over the platform's size limit", async () => {
    const { items, store } = fakeStore();
    setRemoteStore(store);
    const key = uniq("big");
    const noise = Array.from({ length: 4_000_000 }, () => Math.random().toString(36)[2]).join("");
    await cached(key, LONG, async () => noise);
    expect(items.has(key)).toBe(false);
  });
  it("keeps working when the store throws or returns garbage", async () => {
    setRemoteStore({ get: async () => { throw new Error("paused"); }, set: async () => { throw new Error("paused"); } });
    expect((await cached(uniq("throw"), LONG, async () => 5)).value).toBe(5);
    setRemoteStore({ get: async () => "not gzip", set: async () => undefined });
    expect((await cached(uniq("garbage"), LONG, async () => 6)).value).toBe(6);
  });
});
