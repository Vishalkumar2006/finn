import { NextResponse, type NextRequest } from "next/server";
import { cronAuthorised } from "@/lib/monitor/auth";
import { deliver, vapidConfig } from "@/lib/push/send";
import { blobPushStore, mutate } from "@/lib/push/store";
import { claimTest, remove, testPayload } from "@/lib/push/subscription";

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * Admin only: sends one labelled TEST notification to one named device. There is no broadcast: the caller must
 * give the device code shown on that phone. Fails closed without PUSH_ADMIN_SECRET.
 */
export async function POST(req: NextRequest) {
  if (!cronAuthorised(req.headers.get("authorization"), process.env.PUSH_ADMIN_SECRET?.trim() || undefined)) return json({ error: "Unauthorized" }, 401);
  const vapid = vapidConfig();
  if (!vapid) return json({ error: "Notifications are not configured." }, 503);
  let b: { device?: unknown; path?: unknown; sample?: unknown };
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

  const payload = testPayload(b.path, new Date(), b.sample === "daily" ? "daily" : undefined);
  const [d] = await deliver([claim.record], payload, vapid);
  if (d.status === "expired") await mutate(blobPushStore, (doc) => remove(doc, id));
  return json({ device: b.device, status: d.status, pushServiceStatus: d.code ?? null, opens: payload.url }, d.status === "sent" ? 200 : 502);
}
