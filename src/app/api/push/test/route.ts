import { NextResponse, type NextRequest } from "next/server";
import { cronAuthorised } from "@/lib/monitor/auth";
import { deliver, vapidConfig } from "@/lib/push/send";
import { blobPushStore, mutate } from "@/lib/push/store";
import { claimTest, remove, safePath, testPayload } from "@/lib/push/subscription";
import { matchDevice, testBars } from "@/lib/push/personal";
import { SYMBOL_RE } from "@/lib/portfolio";

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * Admin only: sends one labelled TEST notification to one named device. There is no broadcast: the caller must
 * give the device code shown on that phone. Fails closed without PUSH_ADMIN_SECRET.
 */
export async function POST(req: NextRequest) {
  if (!cronAuthorised(req.headers.get("authorization"), process.env.PUSH_ADMIN_SECRET?.trim() || undefined)) return json({ error: "Unauthorized" }, 401);
  const vapid = vapidConfig();
  if (!vapid) return json({ error: "Notifications are not configured." }, 503);
  let b: { device?: unknown; path?: unknown; sample?: unknown; symbol?: unknown; move?: unknown };
  try {
    b = JSON.parse((await req.text()).slice(0, 1024));
  } catch {
    return json({ error: "Expected JSON." }, 400);
  }
  const id = typeof b.device === "string" ? b.device.replace(/-/g, "").toLowerCase() : "";
  if (!/^[0-9a-f]{12}$/.test(id)) return json({ error: "Give the 12-character device code shown on the phone." }, 400);

  const claim = await mutate(blobPushStore, (doc) => claimTest(doc, id, Date.now()));
  if (claim.result === "absent") return json({ error: "No subscription with that device code." }, 404);
  if (!claim.record) return json({ error: `Rate limited. Try again in ${Math.ceil((claim.wait ?? 0) / 1000)} s.` }, 429);

  let payload = testPayload(b.path, new Date(), b.sample === "daily" ? "daily" : undefined);
  if (b.sample === "personal") {
    // A synthetic move run through this device's saved rules by the same matcher the scan uses. Never stored.
    const symbol = typeof b.symbol === "string" && SYMBOL_RE.test(b.symbol) ? b.symbol : "";
    const move = typeof b.move === "number" && Number.isFinite(b.move) && Math.abs(b.move) <= 30 ? b.move : NaN;
    if (!symbol || Number.isNaN(move)) return json({ error: "Give a symbol and a move between -30 and 30." }, 400);
    const cfg = claim.record.personal;
    if (!cfg?.on) return json({ matched: false, reason: "Personal monitoring is off on this device.", sent: false });
    const now = new Date();
    const m = matchDevice({ ...cfg, effectiveFrom: new Date(0).toISOString() }, { startedAt: now.toISOString(), filings: [], bars: new Map([[symbol, testBars(move, now)]]) }, new Set());
    const hit = m.events.find((e) => e.symbol === symbol && e.kind === "price");
    if (!hit) {
      const reason = !cfg.symbols.includes(symbol) ? `${symbol} is not in this device's monitored portfolio.` : `A ${move}% move does not exceed this device's ±${cfg.pricePct}% rule.`;
      return json({ matched: false, reason, sent: false });
    }
    payload = {
      title: `TEST: ${symbol} closed ${move > 0 ? "+" : ""}${move.toFixed(1)}% (synthetic)`,
      body: `TEST, not a real market event: a synthetic move that crosses your ±${cfg.pricePct}% rule. Tap to open ${symbol} research.`,
      url: safePath(`/research/${symbol}`),
      tag: "finn-test",
    };
  }
  const [d] = await deliver([claim.record], payload, vapid);
  if (d.status === "expired") await mutate(blobPushStore, (doc) => remove(doc, id));
  return json({ device: b.device, status: d.status, pushServiceStatus: d.code ?? null, opens: payload.url }, d.status === "sent" ? 200 : 502);
}
