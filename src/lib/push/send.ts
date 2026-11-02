import webpush from "web-push";
import { allowedPushHost, type PushPayload, type PushRecord } from "./subscription";

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/** All three or nothing. Without them the notification switch is hidden rather than shown and failing. */
export function vapidConfig(env: Record<string, string | undefined> = process.env): VapidConfig | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  const subject = env.VAPID_SUBJECT?.trim() || "https://finn-delta-eight.vercel.app";
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject };
}

export type Delivery = { id: string; status: "sent" | "expired" | "failed"; code?: number };

export type Transport = (rec: PushRecord, body: string, vapid: VapidConfig) => Promise<number>;

/** Encrypted (aes128gcm), VAPID-signed delivery. The push service's status code is all that comes back. */
const webPushTransport: Transport = async (rec, body, vapid) => {
  const r = await webpush.sendNotification({ endpoint: rec.endpoint, keys: rec.keys }, body, {
    vapidDetails: vapid, TTL: 600, urgency: "high", timeout: 8000, contentEncoding: "aes128gcm",
  });
  return r.statusCode;
};

/**
 * Sends to the given records, a few at a time. 404 and 410 mean the browser dropped the subscription; the caller
 * deletes those. Logs name the short id and status only, never the endpoint or keys.
 */
export async function deliver(records: PushRecord[], payload: PushPayload, vapid: VapidConfig, transport: Transport = webPushTransport, concurrency = 4): Promise<Delivery[]> {
  const body = JSON.stringify(payload);
  const out: Delivery[] = [];
  const queue = records.slice(0, 50);
  const worker = async () => {
    for (let rec = queue.shift(); rec; rec = queue.shift()) {
      // Checked again at send time, so a record that somehow got in can't make the server call an arbitrary host.
      if (!allowedPushHost(new URL(rec.endpoint).hostname)) {
        out.push({ id: rec.id, status: "failed" });
        continue;
      }
      try {
        const code = await transport(rec, body, vapid);
        out.push({ id: rec.id, status: "sent", code });
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        out.push({ id: rec.id, status: code === 404 || code === 410 ? "expired" : "failed", code });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  for (const d of out) console.log(`push: ${d.id} ${d.status}${d.code ? ` ${d.code}` : ""}`);
  return out;
}
