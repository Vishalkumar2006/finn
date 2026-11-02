"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, Suspense, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { SourceRef } from "@/lib/domain/types";
import { fmtDate } from "@/lib/client";
import { registerWorker } from "./PushPanel";

const TABS = [
  { href: "/", label: "Brief" },
  { href: "/watchlist", label: "Watchlist" },
  { href: "/research", label: "Research" },
  { href: "/alerts", label: "Alerts" },
];

const EvidenceCtx = createContext<(s: SourceRef) => void>(() => {});
export const useEvidence = () => useContext(EvidenceCtx);

const AlertCountCtx = createContext<(n: number) => void>(() => {});
export const useReportUnread = () => useContext(AlertCountCtx);

const DOC_TYPE: Record<SourceRef["docType"], string> = {
  xbrl_results: "Exchange XBRL results filing",
  transcript: "Earnings call transcript",
  annual_report: "Annual report",
  exchange_filing: "Exchange filing",
};

export function Shell({ children }: { children: ReactNode }) {
  const [src, setSrc] = useState<SourceRef | null>(null);
  const [unread, setUnread] = useState(0);
  const close = useCallback(() => setSrc(null), []);
  useEffect(() => {
    registerWorker()?.catch(() => {});
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
  return (
    <EvidenceCtx.Provider value={setSrc}>
      <AlertCountCtx.Provider value={setUnread}>
        <div className="app">
          <Suspense fallback={<nav className="nav" aria-label="Main" />}>
            <NavBar unread={unread} />
          </Suspense>
          <main>{children}</main>
        </div>
        {src && (
          <>
            <div className="sheet-bg" onClick={close} />
            <div className="sheet" role="dialog" aria-modal="true" aria-label="Source">
              <div className="eyebrow">Evidence</div>
              <h2 className="title" style={{ fontSize: 20 }}>{src.title}</h2>
              <dl className="sheet-meta">
                <dt>Type</dt><dd>{DOC_TYPE[src.docType]}</dd>
                {src.period && <><dt>Period</dt><dd>{src.period}</dd></>}
                {src.basis && <><dt>Basis</dt><dd style={{ textTransform: "capitalize" }}>{src.basis}</dd></>}
                {src.filedAt && <><dt>{src.docType === "transcript" ? "Filed" : "Filed"}</dt><dd>{fmtDate(src.filedAt)}</dd></>}
                {src.page != null && <><dt>Page</dt><dd>PDF page {src.page}</dd></>}
                <dt>Host</dt><dd>{new URL(src.url).host}</dd>
              </dl>
              {src.excerpt && <blockquote className="excerpt" style={{ marginInline: 0 }}>{src.excerpt}</blockquote>}
              <div className="acts">
                <a className="btn" href={src.page ? `${src.url}#page=${src.page}` : src.url} target="_blank" rel="noopener noreferrer">Open original</a>
                <button className="btn ghost" onClick={close}>Close</button>
              </div>
            </div>
          </>
        )}
      </AlertCountCtx.Provider>
    </EvidenceCtx.Provider>
  );
}

function NavBar({ unread }: { unread: number }) {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="Main">
      <span className="brand">Finn</span>
      {TABS.map((t) => {
        const active = t.href === "/" ? path === "/" : path.startsWith(t.href);
        return (
          <Link key={t.href} href={t.href} aria-current={active ? "page" : undefined}>
            {t.label}
            {t.href === "/alerts" && unread > 0 && <span className="count" aria-label={`${unread} unread`}>{unread > 99 ? "99+" : unread}</span>}
          </Link>
        );
      })}
    </nav>
  );
}

export function Cite({ source, label }: { source: SourceRef; label: string }) {
  const open = useEvidence();
  return <button className="cite" onClick={() => open(source)} aria-label={`Show source: ${source.title}`}>{label}</button>;
}

export function Skeleton({ lines = 4 }: { lines?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => <div key={i} className={`skel ${i % 3 === 1 ? "w80" : i % 3 === 2 ? "w60" : ""}`} />)}
    </div>
  );
}

export function ErrorNote({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="notice err" role="alert">
      {message}
      {retry && <> <button className="link" onClick={retry}>Try again</button></>}
    </div>
  );
}

export function Sparkline({ values, label }: { values: number[]; label: string }) {
  if (values.length < 2) return <span className="na">—</span>;
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const d = values.map((v, i) => `${i ? "L" : "M"}${((i / (values.length - 1)) * 72 + 1).toFixed(1)} ${(26 - ((v - min) / span) * 24).toFixed(1)}`).join("");
  return <svg className="spark" viewBox="0 0 74 28" role="img" aria-label={label}><title>{label}</title><path d={d} /></svg>;
}
