import { after, NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { bad, failure, parseSymbol } from "@/lib/api";
import { answerQuestion } from "@/lib/research/outcome";
import { allowQuestion, clientKey, sameOrigin } from "@/lib/research/guard";
import { llmEnabled } from "@/lib/research/llm";
import { backgroundWork } from "@/lib/sources/http";
import { withTiming } from "@/lib/timing";

export const maxDuration = 90;

const Body = z.object({ question: z.string().trim().min(4).max(400), previous: z.string().trim().max(400).optional() });

export async function POST(req: NextRequest, ctx: { params: Promise<{ symbol: string }> }) {
  const symbol = parseSymbol((await ctx.params).symbol);
  if (!symbol) return bad("Invalid symbol");
  if (!sameOrigin(req.headers)) return bad("Cross-site requests are not allowed", 403);
  if (!allowQuestion(clientKey(req.headers))) return bad("Too many questions. Wait a minute and try again.", 429);
  if (Number(req.headers.get("content-length") ?? 0) > 4096) return bad("Request too large", 413);
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return bad("Ask a question of 4 to 400 characters");
  try {
    after(backgroundWork); // a slow annual report finishes into the cache after the answer is sent
    const { value, header } = await withTiming(() => answerQuestion(symbol, body.data.question, body.data.previous));
    return NextResponse.json({ ...value, llmConfigured: llmEnabled() }, { headers: { "server-timing": header } });
  } catch (e) {
    return failure(e);
  }
}
