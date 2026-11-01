import { getCache } from "@vercel/functions";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

/** Identifies itself honestly. If a source refuses this, we fall back; we do not disguise the client. */
const UA = "FINN-research-prototype/0.1 (ENAM build challenge)";

export class SourceError extends Error {
  constructor(public source: string, public status: number | null, message: string) {
    super(message);
  }
}

export async function get(url: string, opts: { timeoutMs?: number; retries?: number; source?: string } = {}): Promise<Response> {
  const { timeoutMs = 15000, retries = 1, source = new URL(url).host } = opts;
  let last: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": UA, accept: "*/*" }, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
      if (r.ok) return r;
      // 401/403/404 will not change on retry, and retrying a refusal would be impolite.
      if (r.status < 500 && r.status !== 429) throw new SourceError(source, r.status, `${source} responded ${r.status}`);
      last = new SourceError(source, r.status, `${source} responded ${r.status}`);
    } catch (e) {
      if (e instanceof SourceError && e.status !== 429 && (e.status ?? 500) < 500) throw e;
      last = e;
    }
    if (i < retries) await new Promise((res) => setTimeout(res, 500 * (i + 1)));
  }
  if (last instanceof SourceError) throw last;
  throw new SourceError(source, null, `${source} unreachable: ${last instanceof Error ? last.message : "unknown error"}`);
}

const CACHE_DIR = process.env.VERCEL ? "/tmp/finn-cache" : path.join(process.cwd(), ".cache");
const mem = new Map<string, { at: number; value: unknown }>();

function file(key: string) {
  return path.join(CACHE_DIR, `${createHash("sha1").update(key).digest("hex")}.json.gz`);
}

function readDisk<T>(key: string): { at: number; value: T } | null {
  try {
    const f = file(key);
    if (!existsSync(f)) return null;
    return JSON.parse(gunzipSync(readFileSync(f)).toString("utf8"));
  } catch {
    return null;
  }
}

export interface RemoteStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, options: { ttl: number }): Promise<void>;
}

// Memory and /tmp belong to one server instance. This is shared between instances, and survives deployments, so
// keys carry the deployment id: a fixed parser must never read what the old one stored. Evictable and optional.
let remote: RemoteStore | null = process.env.VERCEL && process.env.VERCEL_DEPLOYMENT_ID ? getCache({ namespace: `finn-${process.env.VERCEL_DEPLOYMENT_ID}` }) : null;
export const setRemoteStore = (s: RemoteStore | null) => { remote = s; };

const REMOTE_MIN_TTL_MS = 3600e3; // short-lived data such as prices is not worth a network read
const REMOTE_MAX_CHARS = 1_900_000; // the platform refuses items over 2 MB
const REMOTE_READ_MS = 1500;
const REMOTE_WRITE_MS = 3000;

async function readRemote<T>(key: string): Promise<{ at: number; value: T } | null> {
  if (!remote) return null;
  try {
    const raw = await Promise.race([remote.get(key), new Promise<null>((res) => setTimeout(() => res(null), REMOTE_READ_MS))]);
    return typeof raw === "string" ? JSON.parse(gunzipSync(Buffer.from(raw, "base64")).toString("utf8")) : null;
  } catch {
    return null;
  }
}

async function writeRemote(key: string, entry: { at: number; value: unknown }, ttlMs: number) {
  if (!remote) return;
  try {
    const raw = gzipSync(JSON.stringify(entry)).toString("base64");
    if (raw.length > REMOTE_MAX_CHARS) return;
    // Kept past its TTL only so a source outage can serve it, marked stale.
    await Promise.race([remote.set(key, raw, { ttl: Math.ceil((ttlMs * 2) / 1000) }), new Promise((res) => setTimeout(res, REMOTE_WRITE_MS))]);
  } catch {
    // Only costs the next instance a download.
  }
}

export interface Cached<T> {
  value: T;
  fetchedAt: string;
  mode: "live" | "cache";
  stale: boolean;
}

const inflight = new Map<string, Promise<unknown>>();

/**
 * Read-through cache: memory, then disk, then the shared store, then source. On a source failure, serves the last good value
 * marked stale rather than failing, and never pretends it is fresh.
 */
export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<Cached<T>> {
  let hit = (mem.get(key) as { at: number; value: T } | undefined) ?? readDisk<T>(key);
  if ((!hit || Date.now() - hit.at >= ttlMs) && ttlMs >= REMOTE_MIN_TTL_MS) {
    const shared = await readRemote<T>(key);
    if (shared && (!hit || shared.at > hit.at)) hit = shared;
  }
  if (hit && Date.now() - hit.at < ttlMs) {
    mem.set(key, hit);
    return { value: hit.value, fetchedAt: new Date(hit.at).toISOString(), mode: "cache", stale: false };
  }
  try {
    let p = inflight.get(key) as Promise<T> | undefined;
    if (!p) {
      // The shared write is part of the work, so backgroundWork keeps the function alive until it lands.
      p = fn()
        .then(async (v) => {
          if (ttlMs >= REMOTE_MIN_TTL_MS) await writeRemote(key, { at: Date.now(), value: v }, ttlMs);
          return v;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    const value = await p;
    const at = Date.now();
    mem.set(key, { at, value });
    try {
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(file(key), gzipSync(JSON.stringify({ at, value })));
    } catch {
      // A read-only disk only costs us the warm start.
    }
    return { value, fetchedAt: new Date(at).toISOString(), mode: "live", stale: false };
  } catch (e) {
    if (hit) return { value: hit.value, fetchedAt: new Date(hit.at).toISOString(), mode: "cache", stale: true };
    throw e;
  }
}

/** Resolves when work already started has finished, so a response can return while a download completes. */
export const backgroundWork = () => Promise.allSettled([...inflight.values()]);

export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}
