import { describe, expect, it } from "vitest";
import { cached, backgroundWork } from "../src/lib/sources/http";
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
    const r = await gatherDocs([doc("t", 3000)], [], late, 1, 1);
    expect(r[0].late).toBe(true);
  }, 3000);
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
