import { connection, NextResponse } from "next/server";
import vercelConfig from "../../../../vercel.json";
import { monitorHealth, type MonitorEvent, type MonitorState, type RunRecord } from "@/lib/domain/monitor";
import { blobStore } from "@/lib/monitor/store";
import { DEFAULT_PORTFOLIO, MONITOR_RULE } from "@/lib/portfolio";

export interface MonitorView {
  available: boolean;
  schedule: string | null;
  portfolioSize: number;
  rule: typeof MONITOR_RULE;
  lastRun: RunRecord | null;
  lastSuccess: RunRecord | null;
  lastAutomatic: RunRecord | null;
  running: boolean;
  stuck: boolean;
  stale: boolean;
  material: MonitorEvent[];
  routine: MonitorEvent[];
  routineTotal: number;
}

const isRoutine = (e: MonitorEvent) => e.kind === "filing" && e.priority === "routine";

function view(state: MonitorState | null, available: boolean): MonitorView {
  const { stale, stuck } = monitorHealth(state, Date.now());
  const events = state?.events ?? [];
  const routine = events.filter(isRoutine);
  return {
    available, schedule: vercelConfig.crons?.[0]?.schedule ?? null, portfolioSize: DEFAULT_PORTFOLIO.length, rule: MONITOR_RULE,
    lastRun: state?.lastRun ?? null, lastSuccess: state?.lastSuccess ?? null, lastAutomatic: state?.lastAutomatic ?? null,
    running: Boolean(state?.current) && !stuck, stuck, stale,
    material: events.filter((e) => !isRoutine(e)).slice(0, 40), routine: routine.slice(0, 30), routineTotal: routine.length,
  };
}

/** Read-only, and holds only public-source data. Writes exist only behind the cron secret. */
export async function GET() {
  await connection(); // never prerender this: a frozen status would be a false one
  const headers = { "cache-control": "public, s-maxage=60, stale-while-revalidate=60" };
  try {
    const r = await blobStore.read(false);
    return NextResponse.json(view(r?.state ?? null, true), { headers });
  } catch {
    console.error("monitor: state store could not be read");
    return NextResponse.json(view(null, false), { headers: { "cache-control": "no-store" } });
  }
}
