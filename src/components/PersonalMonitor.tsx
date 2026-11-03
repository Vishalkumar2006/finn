"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CATEGORY_LABEL, fmtPct, fmtTime, useSettings } from "@/lib/client";
import type { MonitorEvent } from "@/lib/domain/monitor";

interface Saved {
  on: boolean;
  symbols: string[];
  pricePct: number;
  volumeMultiple: number;
  categories: string[];
  updatedAt: string;
  effectiveFrom: string;
}
interface Status {
  config: Saved | null;
  lastRun: { at: string; runStatus: string; filingsRead: boolean; unchecked: string[] } | null;
  alerts: { at: string; status: string; title: string; gaps?: { unchecked: string[]; filingsRead: boolean }; events: MonitorEvent[] }[];
}

const MAX_SYMBOLS = 25;

async function post(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
  if (!sub) throw new Error("Turn phone notifications on first.");
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20e3);
  try {
    const r = await fetch("/api/push/personal", {
      method: "POST", headers: { "content-type": "application/json" }, signal: ctl.signal,
      body: JSON.stringify({ endpoint: sub.endpoint, auth: sub.toJSON().keys?.auth, ...body }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
    return j;
  } catch (e) {
    throw ctl.signal.aborted ? new Error("No response after 20 seconds. Nothing is confirmed saved; try again.") : e instanceof TypeError ? new Error("Network error. Nothing is confirmed saved; try again.") : e;
  } finally {
    clearTimeout(t);
  }
}

const what = (e: MonitorEvent) =>
  e.kind === "filing" ? `${CATEGORY_LABEL[e.category!] ?? "Filing"}: ${e.summary ?? ""}` : e.kind === "price" ? `Closed ${fmtPct(e.value)} (beyond ±${e.threshold}%)` : `Volume ${e.value}× the prior 20-session mean (above ${e.threshold}×)`;

/** The device's own background rules: a saved snapshot of this browser's portfolio and thresholds. */
export function PersonalMonitor() {
  const s = useSettings();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    post({ action: "status" })
      .then((j) => live && setStatus(j as unknown as Status))
      .catch((e) => live && setError(e instanceof Error ? e.message : "Could not read background monitoring settings."));
    return () => {
      live = false;
    };
  }, []);

  const local = { symbols: [...s.symbols].sort(), pricePct: s.pricePct, volumeMultiple: s.volumeMultiple, categories: s.categories.filter((c) => c !== "unclassified").sort() };
  const saved = status?.config;
  const matches = !!saved?.on && JSON.stringify([saved.symbols, saved.pricePct, saved.volumeMultiple, saved.categories]) === JSON.stringify([local.symbols, local.pricePct, local.volumeMultiple, local.categories]);
  const tooMany = local.symbols.length > MAX_SYMBOLS;

  const act = (body: Record<string, unknown>) => async () => {
    setBusy(true);
    setError(null);
    try {
      const j = await post(body);
      setStatus((st) => ({ lastRun: st?.lastRun ?? null, alerts: st?.alerts ?? [], config: (j.config as Saved | null) ?? null }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save. Nothing changed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div id="my-alerts" style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--rule)" }}>
      <div className="rule-row">
        <span>Monitor my portfolio automatically: <strong>{!status ? "Checking…" : saved?.on ? "On" : "Off"}</strong></span>
        {status && (saved?.on && matches ? (
          <button className="btn ghost" disabled={busy} onClick={act({ action: "off" })}>{busy ? "Saving…" : "Turn off"}</button>
        ) : (
          <button className="btn" disabled={busy || tooMany || !local.symbols.length} onClick={act({ action: "save", config: local })}>{busy ? "Saving…" : saved?.on ? "Save current settings" : "Turn on"}</button>
        ))}
      </div>
      {status && saved?.on && (
        <p className="muted" style={{ marginTop: 6 }}>
          {matches ? "Saved rules match your current settings." : "Your settings on this device have changed since they were saved. Background monitoring still uses the saved rules until you save again."}
        </p>
      )}
      {tooMany && <p className="muted" style={{ marginTop: 6, color: "var(--crit)" }}>Background monitoring covers up to {MAX_SYMBOLS} companies per device; your portfolio has {local.symbols.length}. Remove some on Watchlist to turn it on.</p>}
      {error && <p className="muted" role="alert" style={{ marginTop: 6, color: "var(--crit)" }}>{error}</p>}
      {saved?.on && (
        <p style={{ fontSize: 13.5, marginTop: 8, color: "var(--ink-2)" }}>
          Watching {saved.symbols.length} {saved.symbols.length === 1 ? "company" : "companies"} ({saved.symbols.slice(0, 6).join(", ")}{saved.symbols.length > 6 ? `, and ${saved.symbols.length - 6} more` : ""}): close beyond ±{saved.pricePct}%, volume above {saved.volumeMultiple}×,
          and filings of type {saved.categories.length ? saved.categories.map((c) => CATEGORY_LABEL[c as keyof typeof CATEGORY_LABEL] ?? c).join(", ") : "none"}. Rules saved {fmtTime(saved.updatedAt)} IST; only events after that count.
          This replaces the shared daily alerts on this device, so you never get both.
        </p>
      )}
      <p className="muted" style={{ marginTop: 6 }}>
        Checked once a day after the market closes, around 17:30 IST, using NSE filings and end-of-day prices. It is not real-time.
        {status?.lastRun ? ` Last scan ${fmtTime(status.lastRun.at)} IST: ${status.lastRun.runStatus === "success" && status.lastRun.filingsRead && !status.lastRun.unchecked.length ? "complete" : `incomplete${!status.lastRun.filingsRead ? ", filings not read" : ""}${status.lastRun.unchecked.length ? `, no prices for ${status.lastRun.unchecked.join(", ")}` : ""}`}.` : saved?.on ? " No scan has run with these rules yet." : ""}
      </p>
      {!!status?.alerts.length && (
        <div style={{ marginTop: 10 }}>
          <div className="eyebrow">Sent to this device</div>
          {status.alerts.map((a) => (
            <div key={a.at} style={{ marginTop: 8 }}>
              <div style={{ fontSize: 13 }}><strong>{a.title}</strong> · {fmtTime(a.at)} IST{a.status !== "sent" ? ` · ${a.status === "claimed" ? "delivery not confirmed" : a.status}` : ""}</div>
              {a.events.map((e) => (
                <div className="alert" key={e.id}>
                  <span className="dot" aria-hidden />
                  <div>
                    <div className="item-top"><Link className="sym" href={`/research/${e.symbol}`}>{e.symbol}</Link><span>{e.kind === "filing" ? `Filed ${fmtTime(e.at)} IST` : `EOD session ${e.session}`}</span></div>
                    <div style={{ marginTop: 3 }}>{what(e)}</div>
                    {e.why && <div className="muted" style={{ marginTop: 2 }}>{e.why}</div>}
                    <div className="acts" style={{ marginTop: 6 }}>
                      <Link className="link" href={`/research/${e.symbol}`}>Investigate</Link>
                      {e.url && <a className="link" href={e.url} target="_blank" rel="noopener noreferrer">Filing</a>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
