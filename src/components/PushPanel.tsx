"use client";

import { useEffect, useState } from "react";
import { fmtTime } from "@/lib/client";

type State =
  | { kind: "loading" }
  | { kind: "unsupported"; reason: string }
  | { kind: "unconfigured" }
  | { kind: "blocked" }
  | { kind: "off" }
  | { kind: "on"; device: string | null; daily: boolean | null };

const TIMEOUT_MS = 20e3;
const TIMEOUT_NOTE = "No response after 20 seconds. Check your connection and try again; trying again won't create a second subscription.";

function keyBytes(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Bounds a step that can hang on a bad connection (the push service or our API), so the button never stays busy. */
function within<T>(p: Promise<T>): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<never>((_, no) => (t = setTimeout(() => no(new Error(TIMEOUT_NOTE)), TIMEOUT_MS)))]).finally(() => clearTimeout(t));
}

/** The worker only shows notifications and handles taps; it has no fetch handler and caches nothing. */
export function registerWorker(): Promise<ServiceWorkerRegistration> | null {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  return navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
}

async function call(path: string, method: "POST" | "DELETE", body: unknown): Promise<{ device?: string; daily?: boolean; error?: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
    return j;
  } catch (e) {
    throw ctl.signal.aborted ? new Error(TIMEOUT_NOTE) : e instanceof TypeError ? new Error("Network error. Check your connection and try again.") : e;
  } finally {
    clearTimeout(t);
  }
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
  const r = await call("/api/push/subscribe", "POST", sub.toJSON()).catch(() => null);
  return { key, state: { kind: "on", device: r?.device ?? null, daily: r ? !!r.daily : null } };
}

/** Opt-in only: nothing is requested or subscribed until a button is pressed. */
export function PushPanel() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "on" | "off" | "daily">(null);
  const [error, setError] = useState<string | null>(null);
  const [lastScan, setLastScan] = useState<{ at: string; status: string } | null>(null);

  useEffect(() => {
    let live = true;
    detect()
      .catch(() => ({ key: null, state: { kind: "unsupported", reason: "Notification support could not be checked in this browser." } as State }))
      .then((r) => {
        if (!live) return;
        setKey(r.key);
        setState(r.state);
      });
    fetch("/api/monitor")
      .then((r) => r.json())
      .then((m) => {
        if (live && m?.lastAutomatic) setLastScan({ at: m.lastAutomatic.startedAt, status: m.lastAutomatic.status });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const run = async (kind: "on" | "off" | "daily", fn: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const enable = () =>
    run("on", async () => {
      if (!key) return;
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? { kind: "blocked" } : { kind: "off" });
        return;
      }
      const reg = await within(navigator.serviceWorker.ready);
      // Reuses the browser's existing subscription if a previous attempt got that far.
      const sub = (await reg.pushManager.getSubscription()) ?? (await within(reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) })));
      try {
        const r = await call("/api/push/subscribe", "POST", sub.toJSON());
        setState({ kind: "on", device: r.device ?? null, daily: !!r.daily });
      } catch (e) {
        // Don't leave a browser subscription the server doesn't know about.
        await sub.unsubscribe().catch(() => {});
        throw e;
      }
    });

  const disable = () =>
    run("off", async () => {
      const reg = await within(navigator.serviceWorker.ready);
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await call("/api/push/subscribe", "DELETE", { endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      setState({ kind: "off" });
    });

  const setDaily = (on: boolean) =>
    run("daily", async () => {
      const reg = await within(navigator.serviceWorker.ready);
      const sub = await reg.pushManager.getSubscription();
      if (!sub) {
        setState({ kind: "off" });
        return;
      }
      const r = await call("/api/push/daily", "POST", { endpoint: sub.endpoint, auth: sub.toJSON().keys?.auth, on });
      setState((s) => (s.kind === "on" ? { ...s, daily: !!r.daily } : s));
    });

  const status: Record<State["kind"], string> = {
    loading: "Checking this browser…",
    unsupported: "Not supported in this browser",
    unconfigured: "Not available on this server",
    blocked: "Blocked in browser settings",
    off: "Off on this device",
    on: "Allowed on this device",
  };

  return (
    <section className="sect" aria-labelledby="push-h">
      <div className="sect-h"><h2 id="push-h">Phone notifications</h2></div>
      <div className="rule-row">
        <span>Notifications: <strong>{status[state.kind]}</strong></span>
        {state.kind === "off" && <button className="btn" disabled={!!busy} onClick={enable}>{busy === "on" ? "Turning on…" : "Turn on"}</button>}
        {state.kind === "on" && <button className="btn ghost" disabled={!!busy} onClick={disable}>{busy === "off" ? "Turning off…" : "Turn off"}</button>}
      </div>
      {state.kind === "on" && (
        <div className="rule-row">
          <span>Daily portfolio alerts: <strong>{state.daily == null ? "Unknown" : state.daily ? "On" : "Off"}</strong></span>
          {state.daily != null && (
            <button className={state.daily ? "btn ghost" : "btn"} disabled={!!busy} onClick={() => setDaily(!state.daily)}>
              {busy === "daily" ? "Saving…" : state.daily ? "Turn off" : "Turn on"}
            </button>
          )}
        </div>
      )}
      {state.kind === "unsupported" && <p className="muted" style={{ marginTop: 8 }}>{state.reason}</p>}
      {state.kind === "blocked" && <p className="muted" style={{ marginTop: 8 }}>You blocked notifications for this site. To allow them, open the site settings from the address bar, set Notifications to Allow, then reload.</p>}
      {state.kind === "on" && state.device && <p className="muted" style={{ marginTop: 8 }}>Device code: <span style={{ fontFamily: "var(--mono)" }}>{state.device}</span>. It identifies this subscription for a labelled test send.</p>}
      {error && <p className="muted" role="alert" style={{ marginTop: 8, color: "var(--crit)" }}>{error}</p>}
      <p style={{ fontSize: 13.5, marginTop: 8, color: "var(--ink-2)" }}>
        Daily alerts cover FINN&apos;s shared 19-company demo portfolio at fixed rules (close beyond ±4%, volume above 2×, and important filings).
        Your own portfolio and thresholds are not monitored in the background. Monitoring runs once a day, around 17:30 IST; a notification is sent only
        when that scan finds something new, at most one per day, and never for earlier events. Turning alerts on doesn&apos;t send anything old.
      </p>
      <p className="muted" style={{ marginTop: 6 }}>
        Last automatic scan: {lastScan ? `${fmtTime(lastScan.at)} IST, ${lastScan.status}` : "not available"}. A scan finishing doesn&apos;t mean a notification was sent: quiet days send nothing.
        FINN stores only this browser&apos;s push address, keys and your alert choice, and deletes them when you turn notifications off.
      </p>
    </section>
  );
}
