import type { RawAnnouncement } from "../domain/types";
import { get } from "./http";

const BASE = "https://www.nseindia.com/api";
const MONTHS: Record<string, string> = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };

/** "31-Oct-2026 17:34:03" (IST) to ISO with an explicit offset. */
export function nseDate(s: string | null | undefined): string | null {
  const m = s?.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const mon = MONTHS[m[2].toUpperCase()];
  if (!mon) return null;
  return `${m[3]}-${mon}-${m[1].padStart(2, "0")}T${m[4] ?? "00"}:${m[5] ?? "00"}:${m[6] ?? "00"}+05:30`;
}

interface NseAnn {
  symbol: string; sm_name: string; smIndustry?: string; desc: string; attchmntText?: string;
  attchmntFile?: string; an_dt: string; seq_id: string;
}

function toRaw(a: NseAnn): RawAnnouncement | null {
  const at = nseDate(a.an_dt);
  if (!at || !a.symbol) return null;
  return {
    symbol: a.symbol, company: a.sm_name, industry: a.smIndustry, desc: a.desc ?? "",
    text: a.attchmntText ?? "", at, url: a.attchmntFile && a.attchmntFile !== "-" ? a.attchmntFile : null, seqId: String(a.seq_id),
  };
}

const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;

/** from/to are YYYY-MM-DD. Without a symbol this returns every listed company for the range. */
export async function fetchAnnouncements(from: string, to: string, symbol?: string): Promise<RawAnnouncement[]> {
  const sym = symbol ? `&symbol=${encodeURIComponent(symbol)}` : "";
  const r = await get(`${BASE}/corporate-announcements?index=equities&from_date=${ddmmyyyy(from)}&to_date=${ddmmyyyy(to)}${sym}`, { source: "nse", timeoutMs: 30000 });
  const j = (await r.json()) as NseAnn[];
  if (!Array.isArray(j)) return [];
  return j.map(toRaw).filter((x): x is RawAnnouncement => x !== null);
}

export interface ResultFiling {
  xbrl: string;
  periodEnd: string;
  consolidated: boolean;
  filedAt: string | null;
  audited: string | null;
}

function isoDate(s: string | null | undefined) {
  return nseDate(s)?.slice(0, 10) ?? null;
}

/** Results since 2025 live in the integrated-filing feed; the older feed stops at Dec 2024. */
export async function fetchIntegratedResults(symbol: string): Promise<ResultFiling[]> {
  const r = await get(`${BASE}/integrated-filing-results?index=equities&symbol=${encodeURIComponent(symbol)}&period_ended=all&type=${encodeURIComponent("Integrated Filing- Financials")}`, { source: "nse" });
  const j = (await r.json()) as { data?: { xbrl?: string; qe_Date?: string; consolidated?: string | null; broadcast_Date?: string; audited?: string | null }[] };
  const out: ResultFiling[] = [];
  for (const x of j.data ?? []) {
    const periodEnd = isoDate(x.qe_Date);
    if (!x.xbrl || !periodEnd || !x.consolidated) continue;
    out.push({ xbrl: x.xbrl, periodEnd, consolidated: /^consolidated/i.test(x.consolidated), filedAt: nseDate(x.broadcast_Date), audited: x.audited ?? null });
  }
  return out;
}

export async function fetchLegacyResults(symbol: string): Promise<ResultFiling[]> {
  const r = await get(`${BASE}/corporates-financial-results?index=equities&symbol=${encodeURIComponent(symbol)}&period=Quarterly`, { source: "nse" });
  const j = (await r.json()) as { xbrl?: string; toDate?: string; consolidated?: string; filingDate?: string; audited?: string }[];
  if (!Array.isArray(j)) return [];
  const out: ResultFiling[] = [];
  for (const x of j) {
    const periodEnd = isoDate(x.toDate);
    if (!x.xbrl || !periodEnd || !x.xbrl.endsWith(".xml")) continue;
    out.push({ xbrl: x.xbrl, periodEnd, consolidated: /^consolidated/i.test(x.consolidated ?? ""), filedAt: nseDate(x.filingDate), audited: x.audited ?? null });
  }
  return out;
}

export interface AnnualReportFiling {
  url: string;
  fromYr: string;
  toYr: string;
  filedAt: string | null;
}

export async function fetchAnnualReports(symbol: string): Promise<AnnualReportFiling[]> {
  const r = await get(`${BASE}/annual-reports?index=equities&symbol=${encodeURIComponent(symbol)}`, { source: "nse" });
  const j = (await r.json()) as { data?: { fileName?: string; fromYr?: string; toYr?: string; broadcast_dttm?: string }[] };
  return (j.data ?? [])
    .filter((x) => x.fileName?.toLowerCase().endsWith(".pdf") && x.toYr)
    .map((x) => ({ url: x.fileName!, fromYr: x.fromYr ?? "", toYr: x.toYr!, filedAt: nseDate(x.broadcast_dttm) }))
    .sort((a, b) => Number(b.toYr) - Number(a.toYr));
}
