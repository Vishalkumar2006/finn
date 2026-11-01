import { NextResponse } from "next/server";
import { marketSnapshot, researchSeed } from "@/lib/feed";
import { llmEnabled } from "@/lib/research/llm";

export function GET() {
  return NextResponse.json({
    ok: true,
    llm: llmEnabled(),
    scheduledRunAt: marketSnapshot.generatedAt,
    researchSeedAt: researchSeed.generatedAt,
  });
}
