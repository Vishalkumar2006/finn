import { NextResponse } from "next/server";
import { SYMBOL_RE } from "./portfolio";
import { SourceError } from "./sources/http";

export function parseSymbol(raw: string | null | undefined): string | null {
  const s = decodeURIComponent(raw ?? "").trim().toUpperCase();
  return SYMBOL_RE.test(s) ? s : null;
}

export function parseSymbols(raw: string | null): string[] {
  return [...new Set((raw ?? "").split(",").map((s) => parseSymbol(s)).filter((s): s is string => Boolean(s)))].slice(0, 40);
}

export const bad = (message: string, status = 400) => NextResponse.json({ error: message }, { status });

/** Failure messages name the source, never internals. */
export function failure(e: unknown) {
  if (e instanceof SourceError) {
    const notFound = e.status === 404;
    return NextResponse.json({ error: e.message, source: e.source }, { status: notFound ? 404 : 502 });
  }
  console.error("api:", e instanceof Error ? e.message : "unknown");
  return NextResponse.json({ error: "Something went wrong reading the source data." }, { status: 500 });
}
