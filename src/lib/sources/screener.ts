import { get, SourceError } from "./http";

/** Screener is used only to locate company-originated PDFs. Its ratios, tables and AI summaries are never read. */

export interface ScreenerDoc {
  kind: "transcript" | "annual_report";
  url: string;
  label: string;
}

export interface ScreenerMatch {
  symbol: string;
  name: string;
}

export async function searchScreener(q: string): Promise<ScreenerMatch[]> {
  const r = await get(`https://www.screener.in/api/company/search/?q=${encodeURIComponent(q)}`, { source: "screener" });
  const j = (await r.json()) as { name?: string; url?: string }[];
  const out: ScreenerMatch[] = [];
  for (const x of j) {
    const m = x.url?.match(/^\/company\/([A-Z0-9&_-]+)\//); // BSE-only entries use lower-case paths like /company/id/123/
    // Numeric slugs are BSE-only scrip codes with no NSE symbol.
    if (m && !/^\d+$/.test(m[1]) && x.name) out.push({ symbol: m[1].toUpperCase(), name: x.name });
  }
  return out;
}

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ").trim();

/**
 * BSE's AnnPdfOpen page 302s to AttachHis/<file>, but its header is malformed and fetch rejects it.
 * This goes straight to the target BSE itself redirects to.
 */
export function canonicalUrl(url: string): string {
  const m = url.match(/^https:\/\/www\.bseindia\.com\/stockinfo\/AnnPdfOpen\.aspx\?Pname=([\w.-]+\.pdf)/i);
  const clean = m ? `https://www.bseindia.com/xml-data/corpfiling/AttachHis/${m[1]}` : url;
  return clean.split("#")[0];
}

export function parseDocuments(html: string): ScreenerDoc[] {
  const docs: ScreenerDoc[] = [];
  const cStart = html.indexOf("documents concalls");
  if (cStart >= 0) {
    const end = html.indexOf("</ul>", cStart);
    const block = html.slice(cStart, end > 0 ? end : undefined);
    for (const li of block.split(/<li\b/).slice(1)) {
      const date = li.match(/<div[^>]*nowrap[^>]*>\s*([A-Za-z]{3}\s+\d{4})\s*</)?.[1];
      const url = li.match(/href="([^"]+)"[^>]*title="Raw Transcript"/)?.[1];
      if (date && url) docs.push({ kind: "transcript", url: canonicalUrl(decode(url)), label: decode(date) });
    }
  }
  const aStart = html.indexOf("documents annual-reports");
  if (aStart >= 0) {
    const end = html.indexOf("</ul>", aStart);
    const block = html.slice(aStart, end > 0 ? end : undefined);
    for (const m of block.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>\s*([\s\S]*?)<\/a>/g)) {
      const label = decode(m[2].replace(/<[^>]+>/g, " "));
      if (/financial year/i.test(label) || /\b20\d\d\b/.test(label)) docs.push({ kind: "annual_report", url: canonicalUrl(decode(m[1])), label });
    }
  }
  return docs;
}

export async function fetchDocumentIndex(symbol: string): Promise<ScreenerDoc[]> {
  try {
    const r = await get(`https://www.screener.in/company/${encodeURIComponent(symbol)}/`, { source: "screener" });
    return parseDocuments(await r.text());
  } catch (e) {
    if (e instanceof SourceError && e.status === 404) return [];
    throw e;
  }
}
