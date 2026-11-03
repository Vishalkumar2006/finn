import { NextResponse, type NextRequest } from "next/server";
import { DEFAULT_PORTFOLIO } from "@/lib/portfolio";
import { blobDeliveryStore, blobPushStore, mutate, StoreBusy } from "@/lib/push/store";
import { parseConfig, setPersonal, type PersonalConfig } from "@/lib/push/personal";
import { vapidConfig } from "@/lib/push/send";
import { pushId, sameSecret } from "@/lib/push/subscription";
import { clientKey, sameOrigin, WindowCounter } from "@/lib/research/guard";

const perClient = new WindowCounter(20, 60e3);
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

type Body = { action?: unknown; endpoint?: unknown; auth?: unknown; config?: unknown };

async function read(req: NextRequest): Promise<{ b: Body; endpoint: string; auth: string } | NextResponse> {
  if (!vapidConfig()) return json({ error: "Notifications are not configured." }, 503);
  if (!sameOrigin(req.headers)) return json({ error: "Cross-site requests are not allowed." }, 403);
  if (!perClient.allow(clientKey(req.headers))) return json({ error: "Too many requests. Try again in a minute." }, 429);
  const text = await req.text();
  let b: Body | null = null;
  try {
    b = text.length <= 8192 ? JSON.parse(text) : null;
  } catch {}
  if (typeof b?.endpoint !== "string" || b.endpoint.length > 1024 || typeof b.auth !== "string" || b.auth.length > 64) return json({ error: "Invalid request." }, 400);
  return { b, endpoint: b.endpoint, auth: b.auth };
}

const view = (c: PersonalConfig | undefined) => (c ? { on: c.on, symbols: c.symbols, pricePct: c.pricePct, volumeMultiple: c.volumeMultiple, categories: c.categories, updatedAt: c.updatedAt, effectiveFrom: c.effectiveFrom } : null);

/**
 * One device's own background rules. Every action needs that device's endpoint and auth secret: a device code or
 * another device's endpoint gets 404. Returns only this device's rules and the alerts sent to it.
 *   action "save": store `config` and turn personal monitoring on; "off": turn it off; "status": read.
 */
export async function POST(req: NextRequest) {
  const r = await read(req);
  if (r instanceof NextResponse) return r;
  const { b, endpoint, auth } = r;
  const shared = DEFAULT_PORTFOLIO.map((p) => p.symbol);
  try {
    if (b.action === "save" || b.action === "off") {
      const parsed = b.action === "save" ? parseConfig(b.config) : null;
      if (parsed && !parsed.ok) return json({ error: parsed.error }, 400);
      const out = await mutate(blobPushStore, (doc) => setPersonal(doc, endpoint, auth, parsed, shared, new Date()));
      if (out.result === "absent") return json({ error: "This device is not subscribed. Turn notifications on first." }, 404);
      if (out.result === "full") return json({ error: out.error }, 409);
      if (out.result === "saved") console.log(`push: ${pushId(endpoint)} personal ${out.config?.on ? `on, ${out.config.symbols.length} symbols` : "off"}`);
      return json({ ok: true, config: view(out.config) });
    }
    if (b.action !== "status") return json({ error: "Unknown action." }, 400);
    const rec = (await blobPushStore.read())?.doc.subscriptions.find((s) => s.id === pushId(endpoint));
    if (!rec || rec.endpoint !== endpoint || !sameSecret(rec.keys.auth, auth)) return json({ error: "This device is not subscribed." }, 404);
    const ledger = (await blobDeliveryStore.read())?.doc;
    const lastRun = ledger?.personalRuns?.[0] ?? null;
    const alerts = (ledger?.digests ?? [])
      .filter((d) => d.deviceId === rec.id)
      .slice(0, 5)
      .map((d) => ({ at: d.createdAt, status: d.recipients[rec.id]?.status ?? "claimed", title: d.payload.title, gaps: d.gaps, events: d.events ?? [] }));
    const mine = rec.personal?.symbols ?? [];
    return json({
      config: view(rec.personal),
      lastRun: lastRun && { at: lastRun.startedAt, runStatus: lastRun.runStatus, filingsRead: lastRun.filingsRead, unchecked: lastRun.unchecked.filter((s) => mine.includes(s)) },
      alerts,
    });
  } catch (e) {
    console.error(`push: store unavailable on personal: ${e instanceof StoreBusy ? "busy" : e instanceof Error ? e.name : "unknown"}`);
    return json({ error: "Could not reach FINN's settings store. Nothing was changed; try again." }, 503);
  }
}
