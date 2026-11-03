import { NextResponse, type NextRequest } from "next/server";
import { clientKey, sameOrigin, WindowCounter } from "@/lib/research/guard";
import { vapidConfig } from "@/lib/push/send";
import { blobPushStore, mutate, StoreBusy } from "@/lib/push/store";
import { setDaily } from "@/lib/push/subscription";

const perClient = new WindowCounter(10, 60e3);
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

/** Turns daily alerts on or off for the calling device. Proof of ownership: its endpoint plus its auth secret. */
export async function POST(req: NextRequest) {
  if (!vapidConfig()) return json({ error: "Notifications are not configured." }, 503);
  if (!sameOrigin(req.headers)) return json({ error: "Cross-site requests are not allowed." }, 403);
  if (!perClient.allow(clientKey(req.headers))) return json({ error: "Too many requests. Try again in a minute." }, 429);
  const text = await req.text();
  let b: { endpoint?: unknown; auth?: unknown; on?: unknown } | null = null;
  try {
    b = text.length <= 4096 ? JSON.parse(text) : null;
  } catch {}
  if (typeof b?.endpoint !== "string" || b.endpoint.length > 1024 || typeof b.auth !== "string" || b.auth.length > 64 || typeof b.on !== "boolean") {
    return json({ error: "Invalid request." }, 400);
  }
  const { endpoint, auth, on } = b as { endpoint: string; auth: string; on: boolean };
  try {
    const r = await mutate(blobPushStore, (doc) => setDaily(doc, endpoint, auth, on, new Date()));
    if (r.result === "absent") return json({ error: "This device is not subscribed. Turn notifications on first." }, 404);
    return json({ ok: true, daily: r.daily });
  } catch (e) {
    console.error(`push: store unavailable on daily toggle: ${e instanceof StoreBusy ? "busy" : e instanceof Error ? e.name : "unknown"}`);
    return json({ error: "Could not save the setting. Try again." }, 503);
  }
}
