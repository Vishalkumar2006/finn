import { NextResponse, type NextRequest } from "next/server";
import { bad, failure, parseSymbol } from "@/lib/api";
import type { Basis } from "@/lib/domain/types";
import { researchSeed, seedIsFresh } from "@/lib/feed";
import { buildCase, getBusiness, getDocuments, getFinancials, getLedger, type Financials, type Ledger } from "@/lib/research/engine";

export const maxDuration = 60;

async function financials(symbol: string, basis?: Basis): Promise<{ fin: Financials; seeded: boolean }> {
  const seed = researchSeed.financials[symbol];
  if (seed && seedIsFresh() && (!basis || basis === seed.basis)) return { fin: seed, seeded: true };
  try {
    return { fin: await getFinancials(symbol, basis), seeded: false };
  } catch (e) {
    if (seed && (!basis || basis === seed.basis)) return { fin: seed, seeded: true };
    throw e;
  }
}

async function ledger(symbol: string): Promise<{ led: Ledger; seeded: boolean }> {
  const seed = researchSeed.ledgers[symbol];
  if (seed && seedIsFresh()) return { led: seed, seeded: true };
  try {
    return { led: await getLedger(symbol), seeded: false };
  } catch (e) {
    if (seed) return { led: seed, seeded: true };
    throw e;
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ symbol: string }> }) {
  const symbol = parseSymbol((await ctx.params).symbol);
  if (!symbol) return bad("Invalid symbol");
  const part = req.nextUrl.searchParams.get("part");
  const b = req.nextUrl.searchParams.get("basis");
  const basis = b === "consolidated" || b === "standalone" ? b : undefined;
  try {
    switch (part) {
      case "financials": {
        const { fin, seeded } = await financials(symbol, basis);
        return NextResponse.json({ ...fin, seeded, seedAt: seeded ? researchSeed.generatedAt : null });
      }
      case "ledger": {
        const { led, seeded } = await ledger(symbol);
        return NextResponse.json({ ...led, seeded, seedAt: seeded ? researchSeed.generatedAt : null });
      }
      case "case": {
        const [{ fin }, l] = await Promise.all([financials(symbol), ledger(symbol).catch(() => null)]);
        return NextResponse.json({ points: buildCase(fin, l?.led ?? null) });
      }
      case "business":
        return NextResponse.json(await getBusiness(symbol));
      case "documents":
        return NextResponse.json(await getDocuments(symbol));
      default:
        return bad("Unknown part");
    }
  } catch (e) {
    return failure(e);
  }
}
