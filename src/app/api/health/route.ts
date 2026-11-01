import { NextResponse, type NextRequest } from "next/server";
import { marketSnapshot, researchSeed } from "@/lib/feed";
import { llmEnabled } from "@/lib/research/llm";

export function GET(req: NextRequest) {
  return NextResponse.json({
    ok: true,
    now: req.headers.get("x-vercel-id") ? "vercel" : "local",
    llm: llmEnabled(),
    scheduledRunAt: marketSnapshot.generatedAt,
    researchSeedAt: researchSeed.generatedAt,
  });
}
