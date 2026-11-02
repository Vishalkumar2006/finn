"use client";

import Link from "next/link";
import { useApi, CATEGORY_LABEL, fmtDate, fmtPct, fmtTime } from "@/lib/client";
import type { MonitorEvent, RunRecord, SessionStatus } from "@/lib/domain/monitor";
import type { MonitorView } from "@/app/api/monitor/route";
import { Skeleton } from "./Shell";

const SESSION: Record<SessionStatus, string> = {
  traded_today: "traded today",
  weekend: "market closed for the weekend",
  not_closed_yet: "today's session not closed yet",
  no_bars_today: "no bars for today: a market holiday, or not published yet",
  unavailable: "no price data read",
};

const when = (r: RunRecord) => `${fmtTime(r.startedAt)} IST`;

function Event({ e }: { e: MonitorEvent }) {
  const filing = e.kind === "filing";
  const title = filing ? `${e.category ? CATEGORY_LABEL[e.category] : "Filing"}: ${e.summary}`
    : e.kind === "price" ? `Closed ${fmtPct(e.value ?? null)} (beyond ±${e.threshold}%)` : `Volume ${e.value}× the prior 20-session mean (above ${e.threshold}×)`;
  const detail = filing ? `Filed ${fmtTime(e.at)} IST` : `EOD session ${fmtDate(e.session!)}, close ₹${e.close?.toLocaleString("en-IN")}, Yahoo Finance`;
  return (
    <div className="alert">
      <span className="dot read" aria-hidden="true" />
      <div>
        <div className="item-top"><Link className="sym" href={`/research/${e.symbol}`}>{e.symbol}</Link><span>{detail}</span></div>
        <div style={{ marginTop: 3 }}>{title}</div>
        <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{e.baseline ? "Already public when monitoring began." : `Detected ${fmtTime(e.detectedAt)} IST.`}</div>
        {e.url && <div className="acts" style={{ marginTop: 6 }}><a className="link" href={e.url} target="_blank" rel="noopener noreferrer">Filing</a></div>}
      </div>
    </div>
  );
}

/** Background findings for the shared portfolio. Separate from the inbox, which uses this device's own rules. */
export function MonitorPanel() {
  const { data: m, loading, error } = useApi<MonitorView>("/api/monitor");
  if (loading) return <section className="sect"><div className="sect-h"><h2>Daily monitoring</h2></div><Skeleton lines={3} /></section>;
  const run = m?.lastRun;
  return (
    <section className="sect" id="monitoring">
      <div className="sect-h"><h2>Daily monitoring</h2></div>
      {error || !m ? <p className="notice err">Monitoring status could not be loaded, so nothing can be said about the last scan.</p> : (
        <>
          <p className="muted" style={{ marginTop: 6 }}>
            {m.schedule ? "Scheduled once a day, between 17:30 and 18:30 IST" : "No schedule configured"}, for the shared {m.portfolioSize}-company demo portfolio, at ±{m.rule.pricePct}% and {m.rule.volumeMultiple}×. It does not watch your own portfolio or thresholds.
          </p>
          {!m.available && <p className="notice err">The monitoring record could not be read. No scan result is available.</p>}
          {m.available && !run && <p className="notice">No scan has completed yet.</p>}
          {m.running && <p className="notice">A scan is running now.</p>}
          {m.stuck && <p className="notice err">The latest scan started but did not finish.</p>}
          {run?.status === "failed" && <p className="notice err">The latest scan failed at {when(run)}: {run.errors.join(" ")}</p>}
          {run?.status === "partial" && <p className="notice err">The latest scan was incomplete at {when(run)}: {run.errors.join(" ")}</p>}
          {run && m.stale && <p className="notice err">No complete scan in the last 36 hours, so these findings may be out of date.</p>}
          {run && (
            <dl className="muted" style={{ marginTop: 8, fontSize: 13 }}>
              <div>Last automated check: {m.lastAutomatic ? `${when(m.lastAutomatic)}, ${m.lastAutomatic.status}` : "no automatic run recorded yet"}</div>
              <div>Last complete scan: {m.lastSuccess ? `${when(m.lastSuccess)}, ${m.lastSuccess.trigger === "cron" ? "automatic" : "started by hand"}` : "none yet"}</div>
              <div>Latest attempt: {run.companiesChecked} of {run.companiesExpected} companies, {run.filingsChecked == null ? "filings not read" : `${run.filingsChecked} portfolio filings`}, {run.newEvents} new</div>
              {run.latestSession && <div>Latest price session: {fmtDate(run.latestSession)}, {SESSION[run.sessionStatus]}</div>}
            </dl>
          )}
          {m.material.slice(0, 12).map((e) => <Event key={e.id} e={e} />)}
          {run?.status === "success" && !m.material.length && <p className="empty">The last complete scan found no material events.</p>}
          {m.material.length > 12 && (
            <details className="muted" style={{ marginTop: 8 }}><summary>{m.material.length - 12} earlier events</summary>{m.material.slice(12).map((e) => <Event key={e.id} e={e} />)}</details>
          )}
          {m.routineTotal > 0 && (
            <details className="muted" style={{ marginTop: 8 }}><summary>Routine filings ({m.routineTotal})</summary>{m.routine.map((e) => <Event key={e.id} e={e} />)}</details>
          )}
        </>
      )}
    </section>
  );
}
