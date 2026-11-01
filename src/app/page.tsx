"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Cite, ErrorNote, Skeleton } from "@/components/Shell";
import { CATEGORY_LABEL, fmtCr, fmtDate, fmtPct, fmtTime, useApi, useNow, useSettings } from "@/lib/client";
import { comparePeriods, type MetricKey } from "@/lib/domain/metrics";
import type { BriefItem } from "@/lib/domain/types";
import type { BriefResponse, Quote } from "@/lib/feed";
import type { Financials } from "@/lib/research/engine";
import type { FiledProfile } from "@/lib/domain/profile";

type Win = "24h" | "7d" | "custom";

const day = (d: Date) => new Date(d.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);

export default function BriefPage() {
  const s = useSettings();
  const [win, setWin] = useState<Win>("24h");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const now = useNow();
  const range = useMemo(() => {
    if (!now) return null;
    if (win === "24h") return { from: new Date(now - 24 * 3600e3), to: new Date(now) };
    if (win === "7d") return { from: new Date(now - 7 * 24 * 3600e3), to: new Date(now) };
    if (from && to) return { from: new Date(`${from}T00:00:00+05:30`), to: new Date(`${to}T23:59:59+05:30`) };
    return null;
  }, [win, from, to, now]);
  const symbols = s.symbols.join(",");
  const url = range && symbols ? `/api/brief?symbols=${encodeURIComponent(symbols)}&from=${range.from.toISOString()}&to=${range.to.toISOString()}` : null;
  const { data, error, loading, reload } = useApi<BriefResponse>(url);
  const quotes = useApi<{ quotes: Quote[] }>(symbols ? `/api/quotes?symbols=${encodeURIComponent(symbols)}&price=${s.pricePct}&volume=${s.volumeMultiple}&sessions=1` : null);
  const [showRoutine, setShowRoutine] = useState(false);

  const important = data?.items.filter((i) => i.priority === "critical") ?? [];
  const notable = data?.items.filter((i) => i.priority === "notable") ?? [];
  const routine = data?.items.filter((i) => i.priority === "routine") ?? [];
  const movers = (quotes.data?.quotes ?? []).filter((q) => q.events.length);
  const session = quotes.data?.quotes.find((q) => q.lastDate)?.lastDate;

  return (
    <>
      <header className="head">
        <div className="eyebrow">{!now ? "\u00a0" : new Date(now).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Kolkata" })}</div>
        {data ? (
          <p className="lede">
            {data.counts.total === 0 ? "Nothing filed by your holdings in this window." : (
              <><b>{important.length} {important.length === 1 ? "filing matters" : "filings matter"}</b> out of {data.counts.raw} from {data.counts.companies} of your {s.symbols.length} holdings.</>
            )}
          </p>
        ) : <h1 className="title">Your brief</h1>}
      </header>

      <div className="chips" role="group" aria-label="Time window">
        {(["24h", "7d", "custom"] as Win[]).map((w) => (
          <button key={w} className="chip" aria-pressed={win === w} onClick={() => setWin(w)}>{w === "24h" ? "24 hours" : w === "7d" ? "7 days" : "Custom"}</button>
        ))}
      </div>
      {win === "custom" && (
        <div className="dates">
          <label>From <input type="date" value={from} max={to || day(new Date(now))} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>To <input type="date" value={to} min={from} max={day(new Date(now))} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
      )}

      {data && (
        <div className="prov">
          <span className={`tag ${data.provenance.mode}`}>{data.provenance.mode === "live" ? "Live pull" : data.provenance.mode === "cache" ? "Cached" : "Saved snapshot"}</span>
          <span>NSE filings, {fmtTime(data.provenance.fetchedAt)} IST</span>
        </div>
      )}
      {data?.provenance.note && <div className="notice">{data.provenance.note}</div>}
      {win === "custom" && now > 0 && !range && <p className="empty">Pick both dates, up to 31 days apart.</p>}
      {!s.symbols.length && <p className="empty">Your portfolio is empty. <Link className="link" href="/watchlist">Add holdings</Link></p>}
      {loading && <Skeleton lines={8} />}
      {error && <ErrorNote message={`Filings could not be loaded. ${error}`} retry={reload} />}

      {movers.length > 0 && (
        <section className="sect">
          <div className="sect-h"><h2>Unusual on the tape</h2><span className="sub">End of day, {fmtDate(session)}</span></div>
          {movers.map((q) => (
            <div className="item" key={q.symbol}>
              <div className="item-top"><Link className="sym" href={`/research/${q.symbol}`}>{q.symbol}</Link><span className="cat">{s.names[q.symbol]}</span></div>
              <h3>{q.events.map((e) => e.type === "price" ? `Closed ${fmtPct(e.value)} on the day` : `Volume ${e.value}× its 20-session average`).join(" · ")}</h3>
            </div>
          ))}
        </section>
      )}

      {data && data.counts.total === 0 && (
        <div className="empty">
          {win === "24h" && <>Exchanges were shut this weekend, so a quiet day is expected.<br /><button className="btn" onClick={() => setWin("7d")}>See the last 7 days</button></>}
        </div>
      )}

      {important.length > 0 && <Group title="What matters" sub={`${important.length} ranked first`} items={important} />}
      {notable.length > 0 && <Group title="Worth a look" sub={`${notable.length}`} items={notable} />}

      {routine.length > 0 && (
        <section className="sect">
          <button className="fold" aria-expanded={showRoutine} onClick={() => setShowRoutine(!showRoutine)}>
            <span><b>{routine.length} routine</b> disclosures</span><span>{showRoutine ? "Hide" : "Show"}</span>
          </button>
          {showRoutine && routine.map((i) => <Item key={i.seqId} item={i} />)}
        </section>
      )}
    </>
  );
}

function Group({ title, sub, items }: { title: string; sub: string; items: BriefItem[] }) {
  return (
    <section className="sect">
      <div className="sect-h"><h2>{title}</h2><span className="sub">{sub}</span></div>
      {items.map((i) => <Item key={i.seqId} item={i} />)}
    </section>
  );
}

function Item({ item }: { item: BriefItem }) {
  const [open, setOpen] = useState(item.priority === "critical" && item.category === "results");
  return (
    <article className={`item ${item.priority}`}>
      <button className="item-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <div className="item-top">
          <span className="sym">{item.symbol}</span>
          <span className="cat">{CATEGORY_LABEL[item.category]}</span>
          <span className="time">{fmtTime(item.at)}</span>
        </div>
        <h3>{item.summary}</h3>
      </button>
      {open && (
        <>
          <p className="why">{item.why}</p>
          {item.category === "results" && <FirstCut symbol={item.symbol} at={item.at} />}
          {item.category === "management_change" && item.url && <Profile url={item.url} />}
          {item.related.length > 0 && (
            <div className="rel">
              <span className="muted">Grouped with {item.related.length} related {item.related.length === 1 ? "filing" : "filings"}</span>
              <ul>{item.related.map((r) => <li key={r.seqId}>{r.url ? <a className="link" href={r.url} target="_blank" rel="noopener noreferrer">{r.desc}</a> : r.desc} <span className="muted">{fmtTime(r.at)}</span></li>)}</ul>
            </div>
          )}
          <div className="acts">
            {item.url ? <a className="link" href={item.url} target="_blank" rel="noopener noreferrer">Read the filing</a> : <span className="muted">No attachment filed</span>}
            <Link className="link" href={`/research/${item.symbol}`}>Research {item.symbol}</Link>
          </div>
        </>
      )}
    </article>
  );
}

function FirstCut({ symbol, at }: { symbol: string; at: string }) {
  const { data, loading, error } = useApi<Financials>(`/api/research/${encodeURIComponent(symbol)}?part=financials`);
  if (loading) return <Skeleton lines={3} />;
  if (error || !data) return <p className="muted">Structured figures unavailable. Read the filing.</p>;
  const p = data.quarters[0];
  if (!p) return <p className="muted">No quarterly figures filed in XBRL yet.</p>;
  // A filing older than this announcement is last quarter's data; do not pass it off as this result.
  if (p.source.filedAt && Date.parse(at) - Date.parse(p.source.filedAt) > 5 * 24 * 3600e3) {
    return <p className="muted">XBRL for this result is not filed yet (latest filed: {p.label}). Read the PDF below.</p>;
  }
  const rows: [string, MetricKey][] = p.entityClass === "bank"
    ? [[p.revenueLabel, "revenue"], ["NII", "nii"], ["PPOP", "ppop"], ["PBT", "pbt"], ["PAT", "pat"]]
    : [["Revenue", "revenue"], ["EBITDA", "ebitda"], ["PBT", "pbt"], ["PAT", "pat"]];
  return (
    <div style={{ marginTop: 8 }}>
      <div className="table-wrap">
        <table>
          <thead><tr><th>{p.label}, ₹ Cr</th><th>Value</th><th>QoQ</th><th>YoY</th></tr></thead>
          <tbody>
            {rows.map(([label, key]) => {
              const c = comparePeriods(data.quarters, p.periodEnd, key);
              return (
                <tr key={key}>
                  <td>{label}</td>
                  <td>{c.value == null ? <span className="na">{key === "ebitda" && p.entityClass !== "operating" ? "Not meaningful" : "Not available"}</span> : fmtCr(c.value)}</td>
                  <td className={c.qoq == null ? "" : c.qoq >= 0 ? "up" : "down"}>{fmtPct(c.qoq)}</td>
                  <td className={c.yoy == null ? "" : c.yoy >= 0 ? "up" : "down"}>{fmtPct(c.yoy)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="cites"><Cite source={p.source} label={`${data.basis}, ${p.label}`} /></div>
    </div>
  );
}

function Profile({ url }: { url: string }) {
  const { data, loading } = useApi<{ profile: FiledProfile | null; note?: string }>(url.includes("nsearchives.nseindia.com") ? `/api/filing?url=${encodeURIComponent(url)}` : null);
  if (loading) return <Skeleton lines={2} />;
  if (!data?.profile) return <p className="muted">{data?.note ?? "No career profile found in this filing."}</p>;
  return (
    <div style={{ marginTop: 8 }}>
      <span className="muted">From the filing, page {data.profile.page}</span>
      <blockquote className="excerpt" style={{ marginInline: 0, marginBlock: "4px 0" }}>{data.profile.text}</blockquote>
    </div>
  );
}
