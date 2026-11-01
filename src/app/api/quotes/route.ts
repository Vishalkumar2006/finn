import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { bad, failure, parseSymbols } from "@/lib/api";
import { getQuotes, marketSnapshot } from "@/lib/feed";

const Q = z.object({
  price: z.coerce.number().min(0.1).max(50).default(3),
  volume: z.coerce.number().min(1).max(50).default(2),
  sessions: z.coerce.number().int().min(1).max(30).default(10),
});

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const symbols = parseSymbols(sp.get("symbols"));
  if (!symbols.length) return bad("No valid symbols");
  const q = Q.safeParse({ price: sp.get("price") ?? undefined, volume: sp.get("volume") ?? undefined, sessions: sp.get("sessions") ?? undefined });
  if (!q.success) return bad("Thresholds out of range");
  try {
    const quotes = await getQuotes(symbols, { pricePct: q.data.price, volumeMultiple: q.data.volume }, q.data.sessions);
    return NextResponse.json({ quotes, source: "Yahoo Finance end-of-day (.NS)", snapshotAt: marketSnapshot.generatedAt, rule: q.data });
  } catch (e) {
    return failure(e);
  }
}
