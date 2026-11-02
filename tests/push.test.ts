import { createECDH, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import vercel from "../vercel.json";
import { cronAuthorised } from "../src/lib/monitor/auth";
import { deliver, vapidConfig, type Transport } from "../src/lib/push/send";
import { mutate, type PushStore } from "../src/lib/push/store";
import {
  allowedPushHost, claimTest, deviceCode, MAX_SUBSCRIPTIONS, parseSubscription, pushId, remove, safePath, testPayload, upsert,
  type PushDoc, type PushRecord,
} from "../src/lib/push/subscription";

const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const KEYS = { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") };
const FCM = "https://fcm.googleapis.com/fcm/send/abc123:APA91bTest";
const sub = (endpoint = FCM, keys = KEYS) => ({ endpoint, keys, expirationTime: null });
const rec = (endpoint: string): PushRecord => ({ id: pushId(endpoint), endpoint, keys: KEYS, createdAt: "2026-11-02T00:00:00Z" });

describe("subscription validation", () => {
  it("accepts a real browser subscription shape from each push service", () => {
    for (const e of [FCM, "https://updates.push.services.mozilla.com/wpush/v2/gAAA", "https://web.push.apple.com/QK1", "https://wns2-pn1p.notify.windows.com/w/?token=x"]) {
      expect(parseSubscription(sub(e)).ok, e).toBe(true);
    }
  });

  it("refuses endpoints that would make the server fetch anything else", () => {
    for (const e of [
      "http://fcm.googleapis.com/fcm/send/x", "https://fcm.googleapis.com.evil.com/x", "https://evilfcm.googleapis.com/x",
      "https://169.254.169.254/latest/meta-data", "https://localhost/x", "https://user:pw@fcm.googleapis.com/x",
      "https://fcm.googleapis.com:8443/x", "file:///etc/passwd", "javascript:alert(1)", "not a url", `https://fcm.googleapis.com/${"a".repeat(1100)}`,
      "https://evil.com/.notify.windows.com", "https://notify.windows.com.evil.com/x",
    ]) {
      expect(parseSubscription(sub(e)).ok, e).toBe(false);
    }
    expect(allowedPushHost("x.push.apple.com")).toBe(true);
    expect(allowedPushHost("push.apple.com.attacker.net")).toBe(false);
  });

  it("refuses malformed keys and non-objects", () => {
    expect(parseSubscription(null).ok).toBe(false);
    expect(parseSubscription("x").ok).toBe(false);
    expect(parseSubscription({ endpoint: FCM }).ok).toBe(false);
    expect(parseSubscription(sub(FCM, { ...KEYS, auth: randomBytes(8).toString("base64url") })).ok).toBe(false);
    expect(parseSubscription(sub(FCM, { ...KEYS, p256dh: randomBytes(65).toString("base64url").replace(/^./, "A") })).ok).toBe(false);
    expect(parseSubscription(sub(FCM, { ...KEYS, p256dh: "not base64!" })).ok).toBe(false);
  });

  it("keeps the endpoint exactly as the browser sent it, so unsubscribe finds the same record", () => {
    const p = parseSubscription(sub());
    expect(p.ok && p.endpoint).toBe(FCM);
    expect(deviceCode(pushId(FCM))).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
  });
});

describe("notification destinations", () => {
  it("allows only FINN's own screens", () => {
    expect(safePath("/research/LT")).toBe("/research/LT");
    expect(safePath("/research/M&M")).toBe("/research/M&M");
    expect(safePath("/alerts")).toBe("/alerts");
    for (const bad of ["https://evil.com", "//evil.com", "/\\evil.com", "javascript:alert(1)", "/research/LT?x=https://evil.com", "/research/../api/cron/monitor", "/api/push/test", 42, null]) {
      expect(safePath(bad), String(bad)).toBe("/alerts");
    }
  });

  it("the service worker applies the same rule before opening a window", () => {
    const src = readFileSync("public/sw.js", "utf8");
    const fn = src.match(/function safePath[\s\S]*?\n}/)![0];
    const swSafePath = new Function(`${fn}; return safePath;`)() as (p: unknown) => string;
    for (const p of ["/research/LT", "/alerts", "/", "https://evil.com", "//evil.com", "/research/x/../../y", undefined]) expect(swSafePath(p)).toBe(safePath(p));
    expect(src).not.toMatch(/addEventListener\(\s*["']fetch/);
    expect(src).not.toMatch(/caches\./);
  });

  it("test payloads are labelled TEST and carry no market claim", () => {
    const p = testPayload("/research/LT", new Date("2026-11-02T13:00:00Z"));
    expect(p.title).toMatch(/test/i);
    expect(p.body).toMatch(/^TEST: .*18:30 IST.*No market event/);
    expect(testPayload("https://evil.com", new Date()).url).toBe("/alerts");
  });
});

describe("subscription document", () => {
  it("stores an endpoint once, updates rotated keys, and deletes by id", () => {
    const now = new Date();
    const a = upsert(null, sub(), now);
    expect(a.result).toBe("added");
    const again = upsert(a.doc, sub(), now);
    expect(again).toMatchObject({ result: "exists", changed: false });
    const rotated = upsert(a.doc, sub(FCM, { ...KEYS, auth: randomBytes(16).toString("base64url") }), now);
    expect(rotated.changed).toBe(true);
    expect(rotated.doc.subscriptions).toHaveLength(1);
    expect(remove(rotated.doc, pushId(FCM)).doc.subscriptions).toHaveLength(0);
    expect(remove(rotated.doc, "000000000000").result).toBe("absent");
  });

  it("stores no device or personal details beyond the push address", () => {
    const r = upsert(null, { ...sub(), userAgent: "Pixel", ip: "1.2.3.4" } as never, new Date()).doc.subscriptions[0];
    expect(Object.keys(r).sort()).toEqual(["createdAt", "endpoint", "id", "keys"]);
  });

  it("caps the number of devices", () => {
    const doc: PushDoc = { version: 1, subscriptions: Array.from({ length: MAX_SUBSCRIPTIONS }, (_, i) => rec(`${FCM}${i}`)) };
    expect(upsert(doc, sub(`${FCM}new`), new Date()).result).toBe("full");
  });

  it("rate-limits test sends per device", () => {
    let doc: PushDoc = { version: 1, subscriptions: [rec(FCM)] };
    const id = pushId(FCM);
    let t = 1_000_000;
    const first = claimTest(doc, id, t);
    expect(first.record).toBeDefined();
    doc = first.doc;
    expect(claimTest(doc, id, t + 5000).record).toBeUndefined();
    for (let i = 1; i < 5; i++) doc = claimTest(doc, id, (t += 30e3)).doc;
    expect(claimTest(doc, id, t + 30e3).record).toBeUndefined();
    expect(claimTest(doc, id, t + 3600e3).record).toBeDefined();
    expect(claimTest(doc, "ffffffffffff", t).result).toBe("absent");
  });
});

/** An in-memory store with real compare-and-swap, and a hook to interleave another writer between read and write. */
function memoryStore() {
  let doc: PushDoc | null = null;
  let etag = 0;
  let beforeWrite: (() => Promise<void>) | null = null;
  const store: PushStore = {
    async read() {
      return doc ? { doc: structuredClone(doc), etag: String(etag) } : null;
    },
    async write(next, tag) {
      if (beforeWrite) {
        const f = beforeWrite;
        beforeWrite = null;
        await f();
      }
      if ((tag === null && doc) || (tag !== null && tag !== String(etag))) return false;
      doc = structuredClone(next);
      etag++;
      return true;
    },
  };
  return { store, get: () => doc, interleave: (f: () => Promise<void>) => (beforeWrite = f) };
}

describe("concurrent writes", () => {
  it("a subscribe and an unsubscribe racing each other both survive", async () => {
    const m = memoryStore();
    const other = `${FCM}-other`;
    await mutate(m.store, (d) => upsert(d, sub(other), new Date()));
    // Between this subscribe's read and its write, another request removes `other`.
    m.interleave(() => mutate(m.store, (d) => remove(d, pushId(other))).then(() => {}));
    await mutate(m.store, (d) => upsert(d, sub(), new Date()));
    expect(m.get()!.subscriptions.map((r) => r.endpoint)).toEqual([FCM]);
  });

  it("two first-ever subscriptions don't overwrite each other", async () => {
    const m = memoryStore();
    m.interleave(() => mutate(m.store, (d) => upsert(d, sub(`${FCM}-b`), new Date())).then(() => {}));
    await mutate(m.store, (d) => upsert(d, sub(`${FCM}-a`), new Date()));
    expect(m.get()!.subscriptions.map((r) => r.endpoint).sort()).toEqual([`${FCM}-a`, `${FCM}-b`]);
  });

  it("many parallel subscribes are all kept", async () => {
    const m = memoryStore();
    await Promise.all(Array.from({ length: 8 }, (_, i) => mutate(m.store, (d) => upsert(d, sub(`${FCM}-${i}`), new Date()), 20)));
    expect(m.get()!.subscriptions).toHaveLength(8);
  });
});

describe("delivery", () => {
  const vapid = { publicKey: "pub", privateKey: "priv", subject: "https://finn-delta-eight.vercel.app" };
  const payload = testPayload("/alerts", new Date());

  it("marks 404/410 as expired and other failures as failed, and logs no endpoint or key", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const codes: Record<string, number> = { a: 201, b: 410, c: 404, d: 500 };
    const t: Transport = async (r) => {
      const c = codes[r.endpoint.slice(-1)];
      if (c >= 400) throw Object.assign(new Error(`Received unexpected response code ${r.endpoint}`), { statusCode: c });
      return c;
    };
    const out = await deliver(["a", "b", "c", "d"].map((x) => rec(`${FCM}${x}`)), payload, vapid, t);
    expect(out.map((d) => d.status).sort()).toEqual(["expired", "expired", "failed", "sent"]);
    const logged = log.mock.calls.flat().join("\n");
    expect(logged).not.toContain("fcm.googleapis.com");
    expect(logged).not.toContain(KEYS.auth);
    log.mockRestore();
  });

  it("never calls a host outside the push-service list, bounds concurrency and caps a batch", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let live = 0, peak = 0;
    const called: string[] = [];
    const t: Transport = async (r) => {
      called.push(r.endpoint);
      peak = Math.max(peak, ++live);
      await new Promise((ok) => setTimeout(ok, 5));
      live--;
      return 201;
    };
    const many = Array.from({ length: 80 }, (_, i) => rec(`${FCM}${i}`));
    many[0] = rec("https://169.254.169.254/x");
    const out = await deliver(many, payload, vapid, t, 4);
    expect(called).not.toContain("https://169.254.169.254/x");
    expect(out).toHaveLength(50);
    expect(peak).toBeLessThanOrEqual(4);
    vi.restoreAllMocks();
  });

  it("is off unless both VAPID keys are set, and exposes only the public key", () => {
    expect(vapidConfig({})).toBeNull();
    expect(vapidConfig({ VAPID_PUBLIC_KEY: "p" })).toBeNull();
    expect(vapidConfig({ VAPID_PUBLIC_KEY: "p", VAPID_PRIVATE_KEY: "s" })).toMatchObject({ publicKey: "p" });
    const route = readFileSync("src/app/api/push/subscribe/route.ts", "utf8");
    expect(route).not.toMatch(/privateKey/);
    expect(route).not.toMatch(/NEXT_PUBLIC_/);
  });
});

describe("admin test endpoint", () => {
  it("fails closed without a configured secret and refuses the wrong one", () => {
    expect(cronAuthorised("Bearer anything", undefined)).toBe(false);
    expect(cronAuthorised(null, "s3cret-value-123456")).toBe(false);
    expect(cronAuthorised("Bearer wrong", "s3cret-value-123456")).toBe(false);
    expect(cronAuthorised("Bearer s3cret-value-123456", "s3cret-value-123456")).toBe(true);
  });

  it("sends to one named device only; no route can broadcast", () => {
    const route = readFileSync("src/app/api/push/test/route.ts", "utf8");
    expect(route).toContain("PUSH_ADMIN_SECRET");
    expect(route).toMatch(/deliver\(\[claim\.record\]/);
    expect(route).not.toMatch(/subscriptions\b/);
  });

  it("monitoring is untouched: same schedule, and it never reads or sends push", () => {
    expect(vercel.crons).toEqual([{ path: "/api/cron/monitor", schedule: "0 12 * * *" }]);
    for (const f of ["src/app/api/cron/monitor/route.ts", "src/lib/monitor/run.ts", "src/lib/monitor/store.ts"]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/lib\/push|web-push|PushRecord|deliver\(/);
    }
  });
});
