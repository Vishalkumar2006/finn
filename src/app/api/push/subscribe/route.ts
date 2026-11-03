import { connection, NextResponse, type NextRequest } from "next/server";
import { clientKey, sameOrigin, WindowCounter } from "@/lib/research/guard";
import { vapidConfig } from "@/lib/push/send";
import { blobPushStore, mutate, StoreBusy } from "@/lib/push/store";
import { deviceCode, parseSubscription, pushId, remove, upsert } from "@/lib/push/subscription";

// Registration is per device and rare; this only slows scripted floods. The store also caps the total.
const perClient = new WindowCounter(10, 60e3);

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

/** The public key only. The private key never leaves the server. */
export async function GET() {
  await connection();
  const v = vapidConfig();
  return json(v ? { enabled: true, publicKey: v.publicKey } : { enabled: false });
}

async function body(req: NextRequest): Promise<unknown> {
  const text = await req.text();
  if (text.length > 4096) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function gate(req: NextRequest): NextResponse | null {
  if (!vapidConfig()) return json({ error: "Notifications are not configured." }, 503);
  if (!sameOrigin(req.headers)) return json({ error: "Cross-site requests are not allowed." }, 403);
  if (!perClient.allow(clientKey(req.headers))) return json({ error: "Too many requests. Try again in a minute." }, 429);
  return null;
}

/** Saves this device's subscription. Repeating it is harmless: the same endpoint is stored once. */
export async function POST(req: NextRequest) {
  const refused = gate(req);
  if (refused) return refused;
  const parsed = parseSubscription(await body(req));
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  try {
    const r = await mutate(blobPushStore, (doc) => upsert(doc, parsed, new Date()));
    if (r.result === "full") return json({ error: "FINN is not accepting more devices right now." }, 503);
    const id = pushId(parsed.endpoint);
    if (r.result === "added") console.log(`push: ${id} subscribed`);
    return json({ ok: true, device: deviceCode(id), daily: !!r.doc.subscriptions.find((s) => s.id === id)?.daily?.on });
  } catch (e) {
    console.error(`push: store unavailable on subscribe: ${e instanceof StoreBusy ? "busy" : e instanceof Error ? e.name : "unknown"}`);
    return json({ error: "Could not save the subscription. Try again." }, 503);
  }
}

/** Deletes this device's subscription. Knowing the endpoint is the proof of ownership. */
export async function DELETE(req: NextRequest) {
  const refused = gate(req);
  if (refused) return refused;
  const b = (await body(req)) as { endpoint?: unknown } | null;
  if (typeof b?.endpoint !== "string" || b.endpoint.length > 1024) return json({ error: "Invalid endpoint." }, 400);
  const id = pushId(b.endpoint);
  try {
    const r = await mutate(blobPushStore, (doc) => remove(doc, id));
    if (r.result === "removed") console.log(`push: ${id} unsubscribed`);
    return json({ ok: true });
  } catch (e) {
    console.error(`push: store unavailable on unsubscribe: ${e instanceof StoreBusy ? "busy" : e instanceof Error ? e.name : "unknown"}`);
    return json({ error: "Could not remove the subscription. Try again." }, 503);
  }
}
