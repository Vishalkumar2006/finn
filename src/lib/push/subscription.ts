import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Browser push subscriptions. An endpoint is a capability URL: whoever holds it (with the keys) can message that
 * device, so records stay in private storage, logs carry only the short id, and no API returns the list.
 */

export interface PushRecord {
  id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: string;
  /** Times of admin test sends in the last hour, for the rate limit. */
  tests?: number[];
  /** Separate consent for automatic daily alerts. Absent means off: test enrolment never implies it. */
  daily?: { on: boolean; since: string };
}

export interface PushDoc {
  version: 1;
  subscriptions: PushRecord[];
}

export const MAX_SUBSCRIPTIONS = 500;

/** Push services of Chrome/Android (FCM), Firefox, Safari and Edge. Nothing else is ever fetched, so a forged
 *  endpoint cannot point the server at an internal or arbitrary host. */
const EXACT_HOSTS = new Set(["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"]);
const HOST_SUFFIXES = [".push.apple.com", ".notify.windows.com"];

export function allowedPushHost(host: string): boolean {
  const h = host.toLowerCase();
  return EXACT_HOSTS.has(h) || HOST_SUFFIXES.some((s) => h.endsWith(s) && /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(h));
}

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

function b64urlBytes(s: unknown, max: number): Buffer | null {
  if (typeof s !== "string" || !s.length || s.length > max || !B64URL.test(s)) return null;
  return Buffer.from(s.replace(/=+$/, ""), "base64url");
}

export const pushId = (endpoint: string) => createHash("sha256").update(endpoint).digest("hex").slice(0, 12);

/** Shown on the device so the owner can name it for a test send. */
export const deviceCode = (id: string) => id.toUpperCase().match(/.{4}/g)!.join("-");

export type Parsed = { ok: true; endpoint: string; keys: { p256dh: string; auth: string } } | { ok: false; error: string };

/** Accepts exactly the JSON a browser's PushSubscription serialises to; anything else is refused. */
export function parseSubscription(body: unknown): Parsed {
  if (!body || typeof body !== "object") return { ok: false, error: "Expected a push subscription." };
  const { endpoint, keys } = body as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof endpoint !== "string" || endpoint.length > 1024) return { ok: false, error: "Invalid endpoint." };
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, error: "Invalid endpoint." };
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !allowedPushHost(url.hostname)) {
    return { ok: false, error: "Endpoint is not a recognised browser push service." };
  }
  const p256dh = b64urlBytes(keys?.p256dh, 120);
  const auth = b64urlBytes(keys?.auth, 40);
  // An uncompressed P-256 public key is 65 bytes starting 0x04; the auth secret is 16 bytes.
  if (!p256dh || p256dh.length !== 65 || p256dh[0] !== 4) return { ok: false, error: "Invalid subscription key." };
  if (!auth || auth.length !== 16) return { ok: false, error: "Invalid subscription secret." };
  return { ok: true, endpoint, keys: { p256dh: keys!.p256dh as string, auth: keys!.auth as string } };
}

/** Only FINN's own screens. Anything else becomes the Alerts page, so a payload can never send the user off-site. */
export function safePath(path: unknown): string {
  if (typeof path !== "string") return "/alerts";
  if (path === "/alerts" || path === "/") return path;
  return /^\/research\/[A-Z0-9&-]{1,20}$/.test(path) ? path : "/alerts";
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

export function testPayload(path: unknown, now: Date, sample?: "daily"): PushPayload {
  const time = now.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false });
  // The daily-alert layout with no market content at all, so a test can't be mistaken for a real signal.
  if (sample === "daily") {
    return {
      title: "TEST: FINN daily alert format",
      body: `TEST sample sent at ${time} IST, not real events. A real alert would count new important filings and unusual EOD moves. Tap to open Alerts.`,
      url: "/alerts",
      tag: "finn-test",
    };
  }
  return {
    title: "FINN test notification",
    body: `TEST: sent from the FINN server at ${time} IST. Tap to open FINN. No market event triggered this.`,
    url: safePath(path),
    tag: "finn-test",
  };
}

// Pure document edits, applied inside a conditional write so concurrent requests never overwrite each other.

export type Change = { doc: PushDoc; changed: boolean; result: "added" | "exists" | "removed" | "absent" | "full" };

export function upsert(doc: PushDoc | null, sub: { endpoint: string; keys: PushRecord["keys"] }, now: Date): Change {
  const d: PushDoc = doc ?? { version: 1, subscriptions: [] };
  const id = pushId(sub.endpoint);
  const i = d.subscriptions.findIndex((r) => r.id === id);
  if (i >= 0) {
    const r = d.subscriptions[i];
    if (r.keys.p256dh === sub.keys.p256dh && r.keys.auth === sub.keys.auth) return { doc: d, changed: false, result: "exists" };
    const subscriptions = d.subscriptions.slice();
    subscriptions[i] = { ...r, keys: sub.keys };
    return { doc: { ...d, subscriptions }, changed: true, result: "exists" };
  }
  if (d.subscriptions.length >= MAX_SUBSCRIPTIONS) return { doc: d, changed: false, result: "full" };
  const rec: PushRecord = { id, endpoint: sub.endpoint, keys: sub.keys, createdAt: now.toISOString() };
  return { doc: { ...d, subscriptions: [...d.subscriptions, rec] }, changed: true, result: "added" };
}

export function remove(doc: PushDoc | null, id: string): Change {
  if (!doc || !doc.subscriptions.some((r) => r.id === id)) return { doc: doc ?? { version: 1, subscriptions: [] }, changed: false, result: "absent" };
  return { doc: { ...doc, subscriptions: doc.subscriptions.filter((r) => r.id !== id) }, changed: true, result: "removed" };
}

/**
 * Changes daily-alert consent. The caller must present this device's endpoint and its auth secret, which only that
 * browser holds; a device code alone can't change anything.
 */
export function setDaily(doc: PushDoc | null, endpoint: string, auth: string, on: boolean, now: Date): Change & { daily?: boolean } {
  const d = doc ?? { version: 1, subscriptions: [] };
  const id = pushId(endpoint);
  const i = d.subscriptions.findIndex((r) => r.id === id);
  const r = d.subscriptions[i];
  if (i < 0 || r.endpoint !== endpoint || !sameSecret(r.keys.auth, auth)) return { doc: d, changed: false, result: "absent" };
  if (!!r.daily?.on === on) return { doc: d, changed: false, result: "exists", daily: on };
  const subscriptions = d.subscriptions.slice();
  subscriptions[i] = { ...r, daily: { on, since: now.toISOString() } };
  return { doc: { ...d, subscriptions }, changed: true, result: "exists", daily: on };
}

function sameSecret(a: string, b: unknown): boolean {
  if (typeof b !== "string") return false;
  const x = createHash("sha256").update(a).digest(), y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}

export const TEST_LIMIT ={ perHour: 5, minGapMs: 20e3 };

/** Records a test send if the device is under its limit. */
export function claimTest(doc: PushDoc | null, id: string, now: number): Change & { record?: PushRecord; wait?: number } {
  const d = doc ?? { version: 1, subscriptions: [] };
  const i = d.subscriptions.findIndex((r) => r.id === id);
  if (i < 0) return { doc: d, changed: false, result: "absent" };
  const r = d.subscriptions[i];
  const recent = (r.tests ?? []).filter((t) => now - t < 3600e3);
  const last = recent.at(-1);
  if (recent.length >= TEST_LIMIT.perHour) return { doc: d, changed: false, result: "full", wait: recent[0] + 3600e3 - now };
  if (last && now - last < TEST_LIMIT.minGapMs) return { doc: d, changed: false, result: "full", wait: last + TEST_LIMIT.minGapMs - now };
  const record = { ...r, tests: [...recent, now] };
  const subscriptions = d.subscriptions.slice();
  subscriptions[i] = record;
  return { doc: { ...d, subscriptions }, changed: true, result: "exists", record };
}
