"use client";

import { Suspense, use, useState, type FormEvent } from "react";
import { Cite, ErrorNote, Skeleton, Sparkline } from "@/components/Shell";
import { fmtCr, fmtDate, fmtPct, fmtTime, updateSettings, useApi, useSettings } from "@/lib/client";
import { comparePeriods, marginPct, pctChange, ratio, type MetricKey } from "@/lib/domain/metrics";
import type { Basis, GuidanceClaim, GuidanceStatus, PeriodFacts } from "@/lib/domain/types";
import type { Quote } from "@/lib/feed";
import type { Answer, CasePoint, Financials, Ledger, LedgerRow, ResearchDoc, Snapshot } from "@/lib/research/engine";

type Seeded<T> = T & { seeded?: boolean; seedAt?: string | null };

const VERDICT: Record<GuidanceStatus, string> = { exceeded: "Exceeded", met: "Met", missed: "Missed", not_yet: "Not yet due", insufficient: "Can't test" };
const METRIC: Record<GuidanceClaim["metric"], string> = {
  revenue_growth: "Revenue growth", revenue_abs: "Revenue target", ebitda_growth: "EBITDA growth", pat_growth: "PAT growth",
  ebitda_margin: "EBITDA margin", ebit_margin: "EBIT margin", pat_margin: "PAT margin", capex: "Capex", other: "Other",
};

export default function CompanyPage({ params }: { params: Promise<{ symbol: string }> }) {
  return (
    <Suspense fallback={<Skeleton lines={8} />}>
      <Company params={params} />
    </Suspense>
  );
}

function Company({ params }: { params: Promise<{ symbol: string }> }) {
  const symbol = decodeURIComponent(use(params).symbol).toUpperCase();
  const s = useSettings();
  const enc = encodeURIComponent(symbol);
  const quote = useApi<{ quotes: Quote[] }>(`/api/quotes?symbols=${enc}&price=${s.pricePct}&volume=${s.volumeMultiple}&sessions=1`);
  const q = quote.data?.quotes[0];
  const held = s.symbols.includes(symbol);
  const lookup = useApi<{ matches: { symbol: string; name: string }[] }>(s.names[symbol] ? null : `/api/company?q=${enc}`);
  const name = s.names[symbol] ?? lookup.data?.matches.find((m) => m.symbol === symbol)?.name;

  return (
    <>
      <header className="head">
        <div className="eyebrow">{symbol} · NSE</div>
        <h1 className="title">{name ?? symbol}</h1>
        {q?.close != null ? (
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8, fontFamily: "var(--mono)", fontSize: 14 }}>
            <span>₹{q.close.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
            <span className={(q.movePct ?? 0) >= 0 ? "up" : "down"}>{fmtPct(q.movePct)}</span>
            {q.volMultiple != null && <span className="muted">{q.volMultiple}× vol</span>}
            <Sparkline values={q.closes} label={`${symbol} close, last ${q.closes.length} sessions`} />
          </div>
        ) : quote.data && <p className="notice err">No NSE price data for {symbol}. Check the ticker.</p>}
        <div className="prov" style={{ margin: "6px 0 0" }}>
          {q?.lastDate && <span>EOD {fmtDate(q.lastDate)}</span>}
          <button className="link" onClick={() => updateSettings(held ? { symbols: s.symbols.filter((x) => x !== symbol) } : { symbols: [...s.symbols, symbol], names: name ? { ...s.names, [symbol]: name } : s.names })}>{held ? "Remove from portfolio" : "Add to portfolio"}</button>
        </div>
      </header>
      <nav className="jump" aria-label="Sections">
        <a href="#said">Said vs delivered</a><a href="#numbers">Numbers</a><a href="#case">Bull / bear</a><a href="#business">Business</a><a href="#ask">Ask</a><a href="#sources">Sources</a>
      </nav>
      <SaidDelivered symbol={symbol} />
      <Numbers symbol={symbol} />
      <CaseView symbol={symbol} />
      <Business symbol={symbol} />
      <Ask symbol={symbol} />
      <Sources symbol={symbol} />
    </>
  );
}

function SeedTag({ at }: { at?: string | null }) {
  return at ? <div className="prov"><span className="tag snapshot">Saved analysis</span><span>From the run at {fmtTime(at)} IST</span></div> : <div className="prov"><span className="tag live">Fresh analysis</span></div>;
}

function target(c: GuidanceClaim): string {
  if (c.low == null) return "No number";
  const f = (v: number) => (c.unit === "INR" ? `₹${(v / 1e7).toLocaleString("en-IN")} Cr` : `${v}%`);
  if (c.floor) return `≥ ${f(c.low)}`;
  return c.high != null && c.high !== c.low ? `${f(c.low)}–${f(c.high)}` : f(c.low);
}

function SaidDelivered({ symbol }: { symbol: string }) {
  const { data, error, loading, reload } = useApi<Seeded<Ledger>>(`/api/research/${encodeURIComponent(symbol)}?part=ledger`);
  const [all, setAll] = useState(false);
  const contested = (r: LedgerRow) => r.evaluation.status === "insufficient" && r.evaluation.range != null;
  const testable = data?.rows.filter((r) => r.evaluation.status !== "insufficient" || contested(r)) ?? [];
  const rest = data?.rows.filter((r) => r.evaluation.status === "insufficient" && !contested(r)) ?? [];
  return (
    <section className="sect" id="said" style={{ scrollMarginTop: 44 }}>
      <div className="sect-h"><h2>Said vs delivered</h2></div>
      {loading && <><p className="muted" style={{ marginTop: 8 }}>Reading up to six earnings call transcripts…</p><Skeleton lines={6} /></>}
      {error && <ErrorNote message={error} retry={reload} />}
      {data && (
        <>
          <SeedTag at={data.seedAt} />
          <div className="tally">
            <div><b>{data.counts.missed}</b>Missed</div>
            <div><b>{data.counts.met + data.counts.exceeded}</b>Met or beat</div>
            <div><b>{data.counts.not_yet}</b>Not yet due</div>
            <div><b>{data.counts.insufficient}</b>Can&apos;t test</div>
          </div>
          {testable.map((r, i) => <Claim key={i} row={r} basis={data.basis} />)}
          {!testable.length && <p className="empty" style={{ paddingBottom: 8 }}>No statement here pairs a number and a period with a metric in the filings, so FINN gives no verdict.</p>}
          {rest.length > 0 && <button className="fold" aria-expanded={all} onClick={() => setAll(!all)}><span><b>{rest.length}</b> statements FINN could not test</span><span>{all ? "Hide" : "Show"}</span></button>}
          {all && rest.map((r, i) => <Claim key={i} row={r} basis={data.basis} />)}
          <p className="muted" style={{ marginTop: 10 }}>{data.note} Read {data.transcriptsRead.filter((t) => !t.error).length} of {data.transcriptsRead.length} transcripts.{data.transcriptsRead.some((t) => t.error) ? ` Skipped: ${data.transcriptsRead.filter((t) => t.error).map((t) => `${t.label} (${t.error})`).join("; ")}.` : ""}</p>
        </>
      )}
    </section>
  );
}

function Claim({ row, basis }: { row: LedgerRow; basis: Basis }) {
  const { claim: c, evaluation: e } = row;
  const money = c.metric === "revenue_abs";
  return (
    <article className="claim">
      <div className="claim-head">
        <span className={`verdict v-${e.status}`}>{e.status === "insufficient" && e.range ? "Depends on definition" : VERDICT[e.status]}</span>
        <span>{METRIC[c.metric]}</span>
        {c.periodText && <span>· {c.periodText}{c.periodInferred ? " (from prior sentence)" : ""}</span>}
      </div>
      <q>{c.quote}</q>
      {e.actual && (
        <div className="versus">
          <div><span>Guided</span><b>{target(c)}</b></div>
          <div><span>Filed, {e.actual.label}</span><b>{e.status === "insufficient" && e.range ? `${e.range.low}–${e.range.high}%` : money ? `₹${fmtCr(e.actual.value)} Cr` : `${e.actual.value}%`}</b></div>
          <div><span>Gap</span><b>{e.status === "insufficient" ? "—" : money ? (e.variance ? `₹${fmtCr(e.variance)} Cr` : "—") : e.variance ? `${e.variance > 0 ? "+" : ""}${e.variance} pts` : "In band"}</b></div>
        </div>
      )}
      <p className="reason">
        {e.status === "insufficient" ? e.reason : e.actual ? `${e.actual.formula}, ${basis}.${e.range ? ` Holds across ${e.range.low}% to ${e.range.high}% on ${e.range.basisTested}.` : ""}` : e.reason}
      </p>
      <div className="cites">
        <Cite source={row.source} label={`${c.speaker}, ${row.callLabel}, p.${c.page}`} />
        {e.actual && <Cite source={e.actual.source} label={`Actual: ${e.actual.label}`} />}
        {e.actual?.compareSource && <Cite source={e.actual.compareSource} label={`Base: ${e.actual.compareSource.period}`} />}
      </div>
    </article>
  );
}

function Numbers({ symbol }: { symbol: string }) {
  const [basis, setBasis] = useState<Basis | undefined>();
  const { data, error, loading, reload } = useApi<Seeded<Financials>>(`/api/research/${encodeURIComponent(symbol)}?part=financials${basis ? `&basis=${basis}` : ""}`);
  const p = data?.quarters[0];
  return (
    <section className="sect" id="numbers" style={{ scrollMarginTop: 44 }}>
      <div className="sect-h"><h2>Numbers</h2><span className="sub">₹ Cr, from XBRL filed with NSE</span></div>
      {loading && <Skeleton lines={6} />}
      {error && <ErrorNote message={error} retry={reload} />}
      {data && (
        <>
          <div className="chips" style={{ marginTop: 10 }} role="group" aria-label="Basis">
            {data.availableBases.map((b) => <button key={b} className="chip" style={{ textTransform: "capitalize" }} aria-pressed={data.basis === b} onClick={() => setBasis(b)}>{b}</button>)}
          </div>
          {data.availableBases.length === 1 && <p className="muted" style={{ marginTop: 6 }}>Only {data.basis} results are filed for the latest period.</p>}
          {data.coverageNote && <div className="notice">{data.coverageNote}</div>}
          {p ? <QuarterTable data={data} p={p} /> : <p className="empty">No quarterly filings in XBRL.</p>}
          <Trajectory years={data.years} />
        </>
      )}
    </section>
  );
}

function QuarterTable({ data, p }: { data: Financials; p: PeriodFacts }) {
  const rows: [string, MetricKey][] = p.entityClass === "bank"
    ? [[p.revenueLabel, "revenue"], ["Net interest income", "nii"], ["Pre-provision profit", "ppop"], ["PBT", "pbt"], ["PAT", "pat"]]
    : [["Revenue", "revenue"], ["EBITDA", "ebitda"], ["PBT", "pbt"], ["PAT", "pat"]];
  const margin = p.entityClass === "operating" ? marginPct(p.ebitda, p.revenue) : null;
  return (
    <>
      <div className="table-wrap" style={{ marginTop: 10 }}>
        <table>
          <thead><tr><th>{p.label}</th><th>Value</th><th>QoQ</th><th>YoY</th></tr></thead>
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
      <p className="muted" style={{ marginTop: 6 }}>
        {p.entityClass === "operating" ? `EBITDA is derived: revenue minus costs other than finance and depreciation; excludes other income${margin != null ? `. Margin ${margin}%` : ""}.` : "EBITDA does not apply to lenders; their finance cost is an operating cost."}
      </p>
      <div className="cites"><Cite source={p.source} label={`${p.label} filing, ${fmtDate(p.source.filedAt)}`} /></div>
    </>
  );
}

function Trajectory({ years }: { years: PeriodFacts[] }) {
  // Only consecutive years; a gap in filings must not read as a smooth line.
  const ordered = [...years].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd)).slice(-5);
  const shown = ordered.filter((y) => y.revenue != null);
  if (shown.length < 2) return null;
  const max = Math.max(...shown.map((y) => y.revenue!));
  return (
    <div className="trend">
      <h3 style={{ font: "500 14px var(--sans)", marginTop: 16 }}>Annual {shown[0].revenueLabel.toLowerCase()}</h3>
      <div className="trend-bars" style={{ marginTop: 8 }} role="img" aria-label="Annual revenue bars; figures in the table below">
        {shown.map((y) => (
          <div key={y.label} title={`${y.label}: ₹${fmtCr(y.revenue)} Cr`}>
            <span>{fmtCr(y.revenue)}</span>
            <i style={{ height: `${Math.max(2, (y.revenue! / max) * 76)}%` }} />
          </div>
        ))}
      </div>
      <div className="trend-x">{shown.map((y) => <span key={y.label}>{y.label}</span>)}</div>
      <div className="table-wrap" style={{ marginTop: 10 }}>
        <table>
          <thead><tr><th>Year</th><th>Growth</th><th>PAT</th><th>PAT margin</th><th>CFO / PAT</th><th>D/E</th></tr></thead>
          <tbody>
            {[...shown].reverse().map((y) => {
              const prior = years.find((x) => x.periodEnd === `${Number(y.periodEnd.slice(0, 4)) - 1}-03-31`);
              return (
                <tr key={y.label}>
                  <td>{y.label}</td>
                  <td>{fmtPct(pctChange(y.revenue, prior?.revenue))}</td>
                  <td>{fmtCr(y.pat)}</td>
                  <td>{marginPct(y.pat, y.revenue) == null ? "—" : `${marginPct(y.pat, y.revenue)}%`}</td>
                  <td>{y.pat != null && y.pat > 0 && y.cfo != null ? `${ratio(y.cfo, y.pat)}×` : "—"}</td>
                  <td>{y.entityClass === "operating" && y.borrowings != null && y.equity != null && y.equity > 0 ? `${ratio(y.borrowings, y.equity)}×` : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ marginTop: 6 }}>A dash means the filing does not give it. Older filings often omit cash flow and balance sheet.</p>
    </div>
  );
}

function CaseView({ symbol }: { symbol: string }) {
  const { data, error, loading } = useApi<{ points: CasePoint[] }>(`/api/research/${encodeURIComponent(symbol)}?part=case`);
  const side = (k: "bull" | "bear") => data?.points.filter((p) => p.side === k) ?? [];
  const list = (k: "bull" | "bear", title: string) => (
    <div>
      <h3>{title}</h3>
      <ul>
        {side(k).map((p, i) => <li key={i}>{p.text} <Cite source={p.source} label="source" /></li>)}
        {!side(k).length && <li className="muted">No point met the rule.</li>}
      </ul>
    </div>
  );
  return (
    <section className="sect" id="case" style={{ scrollMarginTop: 44 }}>
      <div className="sect-h"><h2>Bull / bear</h2><span className="sub">Rule-based from filings</span></div>
      {loading && <Skeleton lines={4} />}
      {error && <ErrorNote message={error} />}
      {data && <div className="case">{list("bull", "Bull evidence")}{list("bear", "Bear evidence")}</div>}
    </section>
  );
}

function Business({ symbol }: { symbol: string }) {
  const [on, setOn] = useState(false);
  const { data, error, loading } = useApi<Snapshot>(on ? `/api/research/${encodeURIComponent(symbol)}?part=business` : null);
  return (
    <section className="sect" id="business" style={{ scrollMarginTop: 44 }}>
      <div className="sect-h"><h2>Business</h2><span className="sub">Verbatim from the latest annual report</span></div>
      {!on && <div style={{ marginTop: 10 }}><button className="btn ghost" onClick={() => setOn(true)}>Read the annual report</button></div>}
      {loading && <><p className="muted" style={{ marginTop: 8 }}>Parsing the annual report. This can take 30 seconds on first read.</p><Skeleton lines={4} /></>}
      {error && <ErrorNote message={error} />}
      {data && (
        <>
          {data.business.map((b, i) => (
            <div className="claim" key={i}>
              <q>{b.text}</q>
              <div className="cites"><Cite source={b.citation} label={`p.${b.citation.page}`} /></div>
            </div>
          ))}
          {!data.business.length && <p className="empty">No readable annual report text was found.</p>}
          <p className="muted" style={{ marginTop: 8 }}>{data.coverage.join("; ")}</p>
        </>
      )}
    </section>
  );
}

interface Turn { q: string; a?: Answer & { llmConfigured?: boolean }; error?: string }

const SUGGESTIONS = ["What is management saying about margins?", "What are the main risks?", "What is the capex plan?"];

function Ask({ symbol }: { symbol: string }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (question: string) => {
    if (busy || question.trim().length < 4) return;
    const previous = turns.at(-1)?.q;
    setBusy(true);
    setQ("");
    setTurns((t) => [...t, { q: question }]);
    let next: Turn;
    try {
      const r = await fetch(`/api/research/${encodeURIComponent(symbol)}/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question, previous }) });
      const j = await r.json();
      next = r.ok ? { q: question, a: j } : { q: question, error: j.error ?? "Could not answer." };
    } catch {
      next = { q: question, error: "Network error." };
    }
    setTurns((t) => [...t.slice(0, -1), next]);
    setBusy(false);
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit(q);
  };
  return (
    <section className="sect" id="ask" style={{ scrollMarginTop: 44 }}>
      <div className="sect-h"><h2>Ask the documents</h2></div>
      {!turns.length && <div className="suggest">{SUGGESTIONS.map((x) => <button key={x} className="chip" onClick={() => submit(x)} disabled={busy}>{x}</button>)}</div>}
      {turns.map((t, i) => (
        <div className="qa" key={i}>
          <p className="qa-q">{t.q}</p>
          {!t.a && !t.error && <><p className="muted" style={{ marginTop: 6 }}>Searching transcripts and the annual report…</p><Skeleton lines={3} /></>}
          {t.error && <ErrorNote message={t.error} />}
          {t.a && (
            <>
              <div className="qa-a">{t.a.answer.map((x, j) => <p key={j}>{x}</p>)}</div>
              <div className="cites">{t.a.citations.map((c, j) => <Cite key={j} source={c} label={`[${j + 1}] ${c.docType === "annual_report" ? "AR" : "Call"} ${c.title.split(", ").at(-1)} p.${c.page}`} />)}</div>
              <p className="mode">
                {t.a.mode === "llm" ? "Written by a model from these passages; every number checked against them." : t.a.mode === "extractive" ? `Direct quotes, best match. ${t.a.llmConfigured ? "" : "No model is configured, so nothing is paraphrased."}` : "No answer given."}
                {t.a.llmRejected ? ` ${t.a.llmRejected}` : ""}
              </p>
              <details className="muted" style={{ marginTop: 4 }}><summary>What was searched</summary>{t.a.coverage.join("; ")}</details>
            </>
          )}
        </div>
      ))}
      <form className="askbar" onSubmit={onSubmit}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={turns.length ? "Ask a follow-up" : "Ask about this company"} aria-label="Question" maxLength={400} />
        <button className="btn" disabled={busy || q.trim().length < 4}>Ask</button>
      </form>
    </section>
  );
}

function Sources({ symbol }: { symbol: string }) {
  const { data, error, loading } = useApi<{ docs: ResearchDoc[]; discovery: string; fetchedAt: string; stale: boolean }>(`/api/research/${encodeURIComponent(symbol)}?part=documents`);
  return (
    <section className="sect" id="sources" style={{ scrollMarginTop: 44 }}>
      <div className="sect-h"><h2>Sources</h2></div>
      {loading && <Skeleton lines={3} />}
      {error && <ErrorNote message={error} />}
      {data && (
        <>
          {!data.docs.length && <p className="empty">No transcripts or annual reports were found for this company.</p>}
          <div className="results">
            {data.docs.slice(0, 12).map((d) => (
              <a key={d.id} href={d.url} target="_blank" rel="noopener noreferrer">
                <span>{d.kind === "transcript" ? "Earnings call" : "Annual report"}, {d.label}</span><span className="muted">{d.host}</span>
              </a>
            ))}
          </div>
          <p className="muted" style={{ marginTop: 8 }}>Found through {data.discovery}. Checked {fmtTime(data.fetchedAt)} IST{data.stale ? ", source down so this is the last good list" : ""}. No news, broker notes or Screener analysis.</p>
        </>
      )}
    </section>
  );
}
