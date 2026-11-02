"use client";

import { useEffect, useState } from "react";

type State =
  | { kind: "loading" }
  | { kind: "unsupported"; reason: string }
  | { kind: "unconfigured" }
  | { kind: "blocked" }
  | { kind: "off" }
  | { kind: "on"; device: string | null };

function keyBytes(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** The worker only shows notifications and handles taps; it has no fetch handler and caches nothing. */
export function registerWorker(): Promise<ServiceWorkerRegistration> | null {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  return navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
}

async function send(method: "POST" | "DELETE", body: unknown): Promise<{ device?: string; error?: string }> {
  const r = await fetch("/api/push/subscribe", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
  return j;
}

/** What this browser can do and whether it already holds a subscription, plus the server's public key. */
async function detect(): Promise<{ state: State; key: string | null }> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
    return { key: null, state: { kind: "unsupported", reason: ios ? "On iPhone, add FINN to the Home Screen first, then open it from there." : "This browser does not support web push notifications." } };
  }
  const cfg = await fetch("/api/push/subscribe", { cache: "no-store" }).then((r) => r.json()).catch(() => null);
  if (!cfg?.enabled) return { key: null, state: { kind: "unconfigured" } };
  const key = cfg.publicKey as string;
  if (Notification.permission === "denied") return { key, state: { kind: "blocked" } };
  await registerWorker();
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  // A subscription with permission since revoked can't deliver anything, so it counts as off.
  if (!sub || Notification.permission !== "granted") return { key, state: { kind: "off" } };
  // Re-register what the browser already holds; the server stores it once, so this is idempotent.
  const r = await send("POST", sub.toJSON()).catch(() => null);
  return { key, state: { kind: "on", device: r?.device ?? null } };
}

/** Opt-in only: nothing is requested or subscribed until the button is pressed. */
export function PushPanel() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    detect()
      .catch(() => ({ key: null, state: { kind: "unsupported", reason: "Notification support could not be checked in this browser." } as State }))
      .then((r) => {
        if (!live) return;
        setKey(r.key);
        setState(r.state);
      });
    return () => {
      live = false;
    };
  }, []);

  const enable = async () => {
    if (!key) return;
    setBusy(true);
    setError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? { kind: "blocked" } : { kind: "off" });
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }));
      try {
        const r = await send("POST", sub.toJSON());
        setState({ kind: "on", device: r.device ?? null });
      } catch (e) {
        // Don't leave a browser subscription the server doesn't know about.
        await sub.unsubscribe().catch(() => {});
        throw e;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not turn on notifications.");
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setError(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await send("DELETE", { endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      setState({ kind: "off" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not turn off notifications.");
    } finally {
      setBusy(false);
    }
  };

  const status: Record<State["kind"], string> = {
    loading: "Checking this browser…",
    unsupported: "Not supported in this browser",
    unconfigured: "Not available on this server",
    blocked: "Blocked in browser settings",
    off: "Off on this device",
    on: "On for this device",
  };

  return (
    <section className="sect" aria-labelledby="push-h">
      <div className="sect-h"><h2 id="push-h">Phone notifications</h2></div>
      <div className="rule-row">
        <span>Status: <strong>{status[state.kind]}</strong></span>
        {state.kind === "off" && <button className="btn" disabled={busy} onClick={enable}>{busy ? "Turning on…" : "Turn on"}</button>}
        {state.kind === "on" && <button className="btn ghost" disabled={busy} onClick={disable}>{busy ? "Turning off…" : "Turn off"}</button>}
      </div>
      {state.kind === "unsupported" && <p className="muted" style={{ marginTop: 8 }}>{state.reason}</p>}
      {state.kind === "blocked" && <p className="muted" style={{ marginTop: 8 }}>You blocked notifications for this site. To allow them, open the site settings from the address bar, set Notifications to Allow, then reload.</p>}
      {state.kind === "on" && state.device && <p className="muted" style={{ marginTop: 8 }}>Device code: <span style={{ fontFamily: "var(--mono)" }}>{state.device}</span>. It identifies this subscription for a test send.</p>}
      {error && <p className="muted" role="alert" style={{ marginTop: 8, color: "var(--crit)" }}>{error}</p>}
      <p style={{ fontSize: 13.5, marginTop: 8, color: "var(--ink-2)" }}>
        Notifications are for the shared demo portfolio, not your own thresholds or watchlist. For now FINN sends only clearly labelled test notifications;
        daily alert delivery is not switched on yet. FINN stores only this browser&apos;s push address and keys, no name or account, and deletes them when you turn notifications off.
      </p>
    </section>
  );
}
