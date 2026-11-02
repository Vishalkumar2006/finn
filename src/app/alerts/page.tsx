"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { MonitorPanel } from "@/components/MonitorPanel";
import { ErrorNote, Skeleton, useReportUnread } from "@/components/Shell";
import { CATEGORY_LABEL, fmtDate, fmtPct, fmtTime, updateSettings, useApi, useNow, useSettings } from "@/lib/client";
import { CATEGORIES, type Category } from "@/lib/domain/types";
import type { BriefResponse, Quote } from "@/lib/feed";

interface Alert {
  id: string;
  symbol: string;
  when: string;
  title: string;
  detail: string;
  url?: string | null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export default function AlertsPage() {
  const s = useSettings();
  const symbols = encodeURIComponent(s.symbols.join(","));
  const now = useNow();
  const range = now ? `from=${new Date(now - 7 * 24 * 3600e3).toISOString()}&to=${new Date(now).toISOString()}` : "";
  const q = useApi<{ quotes: Quote[]; snapshotAt: string | null }>(symbols ? `/api/quotes?symbols=${symbols}&price=${s.pricePct}&volume=${s.volumeMultiple}&sessions=5` : null);
  const b = useApi<BriefResponse>(symbols && range ? `/api/brief?symbols=${symbols}&${range}` : null);
  const report = useReportUnread();

  const alerts = useMemo<Alert[]>(() => {
    const out: Alert[] = [];
    for (const quote of q.data?.quotes ?? []) {
      for (const e of quote.events) {
        out.push({
          id: `${quote.symbol}:${e.date}:${e.type}`, symbol: quote.symbol, when: `${e.date}T18:00:00+05:30`,
          title: e.type === "price" ? `Closed ${fmtPct(e.value)} (beyond ±${e.threshold}%)` : `Volume ${e.value}× the prior 20-session mean (above ${e.threshold}×)`,
          detail: `EOD session ${fmtDate(e.date)}, close ₹${e.close.toLocaleString("en-IN")}`,
        });
      }
    }
    for (const i of b.data?.items ?? []) {
      if (!s.categories.includes(i.category) || i.priority === "routine") continue;
      out.push({ id: `f:${i.seqId}`, symbol: i.symbol, when: i.at, title: `${CATEGORY_LABEL[i.category]}: ${i.summary}`, detail: `Filed ${fmtTime(i.at)} IST`, url: i.url });
    }
    return out.sort((x, y) => Date.parse(y.when) - Date.parse(x.when));
  }, [q.data, b.data, s.categories]);

  const unread = alerts.filter((a) => !s.readAlerts.includes(a.id)).length;
  useEffect(() => report(unread), [unread, report]);

  const toggle = (c: Category) => updateSettings({ categories: s.categories.includes(c) ? s.categories.filter((x) => x !== c) : [...s.categories, c] });
  const [price, setPrice] = useState(String(s.pricePct));
  const [vol, setVol] = useState(String(s.volumeMultiple));
  const commit = () => {
    const p = Number(price), v = Number(vol);
    const pricePct = Number.isFinite(p) && p > 0 ? clamp(p, 0.1, 50) : s.pricePct;
    const volumeMultiple = Number.isFinite(v) && v > 0 ? clamp(v, 1, 50) : s.volumeMultiple;
    setPrice(String(pricePct));
    setVol(String(volumeMultiple));
    updateSettings({ pricePct, volumeMultiple });
  };

  return (
    <>
      <header className="head">
        <div className="eyebrow">Your thresholds, last 5 sessions and 7 days</div>
        <h1 className="title">{unread ? `${unread} unread` : "All caught up"}</h1>
      </header>

      <section>
        <div className="sect-h"><h2>Your inbox</h2>{unread > 0 && <button className="link" style={{ fontSize: 13 }} onClick={() => updateSettings({ readAlerts: [...new Set([...s.readAlerts, ...alerts.map((a) => a.id)])] })}>Mark all read</button>}</div>
        {(q.loading || b.loading) && <Skeleton lines={6} />}
        {q.error && <ErrorNote message={`Price alerts unavailable. ${q.error}`} retry={q.reload} />}
        {b.error && <ErrorNote message={`Filing alerts unavailable. ${b.error}`} retry={b.reload} />}
        {!q.loading && !b.loading && !alerts.length && !q.error && !b.error && <p className="empty">Nothing crossed your thresholds. Loosen them below to see more.</p>}
        {alerts.map((a) => {
          const read = s.readAlerts.includes(a.id);
          return (
            <div className="alert" key={a.id}>
              <span className={`dot ${read ? "read" : ""}`} aria-label={read ? "Read" : "Unread"} />
              <div>
                <div className="item-top"><Link className="sym" href={`/research/${a.symbol}`}>{a.symbol}</Link><span>{a.detail}</span></div>
                <div style={{ marginTop: 3 }}>{a.title}</div>
                <div className="acts" style={{ marginTop: 6 }}>
                  <Link className="link" href={`/research/${a.symbol}`}>Investigate</Link>
                  {a.url && <a className="link" href={a.url} target="_blank" rel="noopener noreferrer">Filing</a>}
                  {!read && <button className="link" onClick={() => updateSettings({ readAlerts: [...s.readAlerts, a.id] })}>Mark read</button>}
                </div>
              </div>
            </div>
          );
        })}
      </section>

      <MonitorPanel />

      <section className="sect">
        <div className="sect-h"><h2>What counts as unusual</h2></div>
        <div className="rule-row">
          <label htmlFor="p">Daily close move beyond ±</label>
          <span><input id="p" type="number" min="0.1" max="50" step="0.5" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} onBlur={commit} /> %</span>
        </div>
        <div className="rule-row">
          <label htmlFor="v">Volume above, vs prior 20-session mean</label>
          <span><input id="v" type="number" min="1" max="50" step="0.5" inputMode="decimal" value={vol} onChange={(e) => setVol(e.target.value)} onBlur={commit} /> ×</span>
        </div>
        <p className="muted" style={{ marginTop: 10 }}>Filing types that alert you:</p>
        <div className="switches" role="group" aria-label="Filing types">
          {CATEGORIES.filter((c) => c !== "unclassified").map((c) => (
            <button key={c} className="chip" aria-pressed={s.categories.includes(c)} onClick={() => toggle(c)}>{CATEGORY_LABEL[c]}</button>
          ))}
        </div>
      </section>

      <section className="sect">
        <div className="sect-h"><h2>How this runs</h2></div>
        <p style={{ fontSize: 13.5, marginTop: 8, color: "var(--ink-2)" }}>
          Your inbox is checked on the server when you open this page, using your portfolio, your thresholds and end-of-day prices. It is not intraday.
          Daily monitoring is separate: it runs in the background once a day, on the shared demo portfolio and fixed rules only, and its results appear when you open the app. If a source is unreachable, FINN uses a saved snapshot, refreshed by hand{q.data?.snapshotAt ? `, last on ${fmtTime(q.data.snapshotAt)} IST` : ""}, and labels it; daily monitoring never does, and reports the failure instead.
          Alerts appear here in the app. There are no phone or email notifications yet, and your rules stay on this device.
        </p>
      </section>
    </>
  );
}
