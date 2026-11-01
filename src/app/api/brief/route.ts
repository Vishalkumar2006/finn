import { NextResponse, type NextRequest } from "next/server";
import { bad, failure, parseSymbols } from "@/lib/api";
import { getBrief } from "@/lib/feed";

const MAX_DAYS = 31;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const symbols = parseSymbols(sp.get("symbols"));
  if (!symbols.length) return bad("No valid symbols");
  const to = Date.parse(sp.get("to") ?? "") || Date.now();
  const from = Date.parse(sp.get("from") ?? "") || to - 24 * 3600e3;
  if (from >= to) return bad("The start must be before the end");
  if (to - from > MAX_DAYS * 24 * 3600e3) return bad(`Choose a window of ${MAX_DAYS} days or less`);
  try {
    return NextResponse.json(await getBrief(symbols, new Date(from).toISOString(), new Date(to).toISOString()));
  } catch (e) {
    return failure(e);
  }
}
