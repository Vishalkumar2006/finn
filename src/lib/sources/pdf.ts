import { getDocumentProxy } from "unpdf";
import { addTiming } from "../timing";
import { cached, get, SourceError } from "./http";

const MAX_BYTES = 40 * 1024 * 1024;

export interface ParsedPdf {
  url: string;
  pageCount: number;
  pages: string[]; // pages[i] is printed-file page i+1, possibly truncated by maxPages
  scanned: boolean;
}

async function parse(url: string, maxPages: number): Promise<ParsedPdf> {
  const t0 = Date.now();
  const r = await get(url, { timeoutMs: 45000, source: new URL(url).host });
  const buf = await r.arrayBuffer();
  addTiming("download", Date.now() - t0);
  const t1 = Date.now();
  if (buf.byteLength > MAX_BYTES) throw new SourceError(url, null, "PDF exceeds the 40 MB limit");
  const head = new TextDecoder().decode(buf.slice(0, 5));
  if (head !== "%PDF-") throw new SourceError(url, null, "Source did not return a PDF");
  const pdf = await getDocumentProxy(new Uint8Array(buf), { verbosity: 0 });
  const pageCount = pdf.numPages;
  const pages: string[] = [];
  const limit = Math.min(pageCount, maxPages);
  for (let i = 1; i <= limit; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    let out = "";
    let lastY: number | null = null;
    for (const item of content.items as { str?: string; transform?: number[]; hasEOL?: boolean }[]) {
      if (typeof item.str !== "string") continue;
      const y = item.transform?.[5] ?? null;
      if (lastY != null && y != null && Math.abs(y - lastY) > 2) out += "\n";
      out += item.str;
      if (item.hasEOL) out += "\n";
      if (y != null) lastY = y;
    }
    pages.push(out.replace(/[ \t]+/g, " ").trim());
    page.cleanup();
    // Parsing runs on the request's thread. Without this pause, time budgets elsewhere can't fire on a large report.
    await new Promise((res) => setImmediate(res));
  }
  addTiming("parse", Date.now() - t1);
  const chars = pages.reduce((a, p) => a + p.length, 0);
  return { url, pageCount, pages, scanned: pages.length > 0 && chars / pages.length < 80 };
}

/** Parsed PDFs are immutable, so they are cached for 30 days and reused by every feature. */
export async function loadPdf(url: string, maxPages = 400) {
  return cached(`pdf:${maxPages}:${url}`, 30 * 24 * 3600e3, () => parse(url, maxPages));
}
