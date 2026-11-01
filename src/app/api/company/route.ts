import { NextResponse, type NextRequest } from "next/server";
import { bad, failure } from "@/lib/api";
import { resolveCompany } from "@/lib/research/engine";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q") ?? "";
  if (q.trim().length < 2) return bad("Type at least two characters");
  try {
    return NextResponse.json(await resolveCompany(q));
  } catch (e) {
    return failure(e);
  }
}
