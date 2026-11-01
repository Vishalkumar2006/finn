import { NextResponse, type NextRequest } from "next/server";
import { marketSnapshot, researchSeed } from "@/lib/feed";
import { llmEnabled } from "@/lib/research/llm";

export function GET(req: NextRequest) {
  return NextResponse.json({
    ok: true,
    host: req.headers.get("x-vercel-id") ? "vercel" : "local",
    llm: llmEnabled(),
    marketSnapshotAt: marketSnapshot.generatedAt,
    researchSeedAt: researchSeed.generatedAt,
  });
}
