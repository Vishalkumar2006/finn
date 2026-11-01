"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorNote, Skeleton } from "@/components/Shell";
import { useApi } from "@/lib/client";
import { RESEARCH_PICKS } from "@/lib/portfolio";
import type { CompanyMatch } from "@/lib/research/engine";

export default function ResearchHome() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const { data, error, loading } = useApi<{ matches: CompanyMatch[]; degraded: boolean }>(debounced.length >= 2 ? `/api/company?q=${encodeURIComponent(debounced)}` : null);

  return (
    <>
      <header className="head">
        <div className="eyebrow">Filings, transcripts and annual reports only</div>
        <h1 className="title">What did they promise, and did they deliver?</h1>
      </header>
      <form
        className="search"
        onSubmit={(e) => {
          e.preventDefault();
          const top = data?.matches[0];
          if (top) router.push(`/research/${top.symbol}`);
        }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Any NSE company or ticker" aria-label="Search for a company" autoCapitalize="characters" autoCorrect="off" />
      </form>
      {loading && <Skeleton lines={3} />}
      {error && <ErrorNote message={error} />}
      {data?.degraded && <div className="notice">One search source did not respond, so results may be incomplete.</div>}
      <div className="results">
        {data?.matches.map((c) => (
          <Link key={c.symbol} href={`/research/${c.symbol}`}><span>{c.name}</span><span className="sym">{c.symbol}</span></Link>
        ))}
      </div>
      {data && !data.matches.length && <p className="empty">No NSE-listed company matches “{debounced}”.</p>}

      {!debounced && (
        <section className="sect">
          <div className="sect-h"><h2>Good places to start</h2></div>
          <div className="results">
            {RESEARCH_PICKS.map((p) => (
              <Link key={p.symbol} href={`/research/${p.symbol}`}>
                <span>{p.name}<br /><span className="muted">{p.note}</span></span>
                <span className="sym">{p.symbol}</span>
              </Link>
            ))}
          </div>
          <p className="muted" style={{ marginTop: 10 }}>The same engine runs on every ticker. Nothing here is pre-written.</p>
        </section>
      )}
    </>
  );
}
