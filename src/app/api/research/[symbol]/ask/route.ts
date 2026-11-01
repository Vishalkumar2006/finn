import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { bad, failure, parseSymbol } from "@/lib/api";
import { ask } from "@/lib/research/engine";
import { llmEnabled } from "@/lib/research/llm";

export const maxDuration = 60;

const Body = z.object({ question: z.string().trim().min(4).max(400), previous: z.string().trim().max(400).optional() });

export async function POST(req: NextRequest, ctx: { params: Promise<{ symbol: string }> }) {
  const symbol = parseSymbol((await ctx.params).symbol);
  if (!symbol) return bad("Invalid symbol");
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return bad("Ask a question of 4 to 400 characters");
  try {
    return NextResponse.json({ ...(await ask(symbol, body.data.question, body.data.previous)), llmConfigured: llmEnabled() });
  } catch (e) {
    return failure(e);
  }
}
