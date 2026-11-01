import { NextResponse, type NextRequest } from "next/server";
import { bad, failure } from "@/lib/api";
import { extractProfile } from "@/lib/domain/profile";
import { loadPdf } from "@/lib/sources/pdf";

/** Fixed host list: this endpoint must not become a way to make the server fetch arbitrary URLs. */
const ALLOWED = new Set(["nsearchives.nseindia.com"]);

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("url") ?? "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return bad("Invalid URL");
  }
  if (url.protocol !== "https:" || !ALLOWED.has(url.host) || !url.pathname.toLowerCase().endsWith(".pdf")) return bad("Only NSE filing PDFs are allowed");
  try {
    const pdf = await loadPdf(url.toString(), 12);
    if (pdf.value.scanned) return NextResponse.json({ profile: null, note: "Scanned filing with no text layer. Open the source to read it." });
    return NextResponse.json({ profile: extractProfile(pdf.value.pages), pageCount: pdf.value.pageCount });
  } catch (e) {
    return failure(e);
  }
}
