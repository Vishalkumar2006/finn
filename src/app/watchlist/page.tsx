"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ErrorNote, Skeleton, Sparkline } from "@/components/Shell";
import { fmtDate, fmtPct, fmtTime, updateSettings, useApi, useSettings } from "@/lib/client";
import type { Quote } from "@/lib/feed";
import type { CompanyMatch } from "@/lib/research/engine";

export default function WatchlistPage() {
  const s = useSettings();
  const symbols = s.symbols.join(",");
  const { data, error, loading, reload } = useApi<{ quotes: Quote[]; source: string }>(symbols ? `/api/quotes?symbols=${encodeURIComponent(symbols)}&price=${s.pricePct}&volume=${s.volumeMultiple}&sessions=1` : null);
  const [editing, setEditing] = useState(false);
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const found = useApi<{ matches: CompanyMatch[] }>(debounced.length >= 2 ? `/api/company?q=${encodeURIComponent(debounced)}` : null);
  const quotes = [...(data?.quotes ?? [])].sort((a, b) => Math.abs(b.movePct ?? 0) - Math.abs(a.movePct ?? 0));
  const session = data?.quotes.find((x) => x.lastDate)?.lastDate;
  const m = data?.quotes.find((x) => x.lastDate);

  const add = (c: CompanyMatch) => {
    if (s.symbols.includes(c.symbol)) return;
    updateSettings({ symbols: [...s.symbols, c.symbol], names: { ...s.names, [c.symbol]: c.name } });
    setQ("");
  };

  return (
    <>
      <header className="head">
        <div className="eyebrow">End of day, not live</div>
        <h1 className="title">{s.symbols.length} holdings</h1>
      </header>
      <div className="prov" style={{ justifyContent: "space-between" }}>
        <span>
          {m && <span className={`tag ${m.mode}`}>{m.mode === "live" ? "Live pull" : m.mode === "cache" ? "Cached" : "Saved snapshot"}</span>}{" "}
          Last session {fmtDate(session)}{m?.fetchedAt ? `, pulled ${fmtTime(m.fetchedAt)} IST` : ""}
        </span>
        <button className="link" onClick={() => setEditing(!editing)}>{editing ? "Done" : "Edit"}</button>
      </div>

      {editing && (
        <div style={{ marginBottom: 12 }}>
          <div className="search">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Add a company or NSE ticker" aria-label="Add a company" />
          </div>
          <div className="results">
            {found.data?.matches.map((c) => (
              <button key={c.symbol} onClick={() => add(c)} disabled={s.symbols.includes(c.symbol)}>
                <span>{c.name}</span><span className="sym">{s.symbols.includes(c.symbol) ? "Held" : `+ ${c.symbol}`}</span>
              </button>
            ))}
            {found.data && found.data.matches.length === 0 && <p className="muted" style={{ padding: "10px 0" }}>No NSE-listed match.</p>}
          </div>
        </div>
      )}

      {loading && <Skeleton lines={10} />}
      {error && <ErrorNote message={`Prices could not be loaded. ${error}`} retry={reload} />}
      {!s.symbols.length && <p className="empty">No holdings yet. Tap Edit to add one.</p>}

      {quotes.map((q) => (
        <div key={q.symbol} style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Link className="row" style={{ flex: 1, minWidth: 0 }} href={`/research/${q.symbol}`}>
            <div style={{ minWidth: 0 }}>
              <div className="sym">{q.symbol}</div>
              <div className="name">{s.names[q.symbol] ?? q.symbol}</div>
            </div>
            <Sparkline values={q.closes} label={`${q.symbol} close, last ${q.closes.length} sessions`} />
            <div className="nums">
              {q.close == null ? <span className="na">Not available</span> : q.close.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
              <small className={q.movePct == null ? "" : q.movePct >= 0 ? "up" : "down"}>{fmtPct(q.movePct)}</small>
              <small className="muted" title="Volume vs mean of prior 20 sessions">{q.volMultiple == null ? "" : `${q.volMultiple}× vol`}</small>
            </div>
          </Link>
          {editing && <button className="cite" onClick={() => updateSettings({ symbols: s.symbols.filter((x) => x !== q.symbol) })} aria-label={`Remove ${q.symbol}`}>Remove</button>}
        </div>
      ))}
      {data && <p className="muted" style={{ marginTop: 12 }}>{data.source}. Saved on this device. Sorted by size of move.</p>}
    </>
  );
}
