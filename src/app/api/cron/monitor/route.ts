import { NextResponse, type NextRequest } from "next/server";
import { cronAuthorised } from "@/lib/monitor/auth";
import { runScan } from "@/lib/monitor/run";
import { blobStore } from "@/lib/monitor/store";
import { DEFAULT_PORTFOLIO, MONITOR_RULE } from "@/lib/portfolio";
import { fetchAnnouncements } from "@/lib/sources/nse";
import { fetchHistory } from "@/lib/sources/yahoo";

export const maxDuration = 120;

export async function GET(req: NextRequest) {
  if (!cronAuthorised(req.headers.get("authorization"), process.env.CRON_SECRET)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const trigger = req.headers.get("x-vercel-cron-schedule") || req.headers.get("user-agent")?.startsWith("vercel-cron") ? "cron" : "manual";
  try {
    const r = await runScan({
      store: blobStore,
      symbols: DEFAULT_PORTFOLIO.map((p) => p.symbol),
      rule: MONITOR_RULE,
      fetchFilings: (from, to) => fetchAnnouncements(from, to),
      fetchBars: async (symbol) => (await fetchHistory(symbol)).bars,
    }, trigger);
    if (r.outcome === "skipped") return NextResponse.json(r);
    console.log(`monitor: ${r.run.trigger} run ${r.run.status}, ${r.run.companiesChecked}/${r.run.companiesExpected} companies, ${r.run.filingsChecked ?? "no"} filings, ${r.run.newEvents} new`);
    return NextResponse.json(r, { status: r.run.status === "failed" ? 502 : 200 });
  } catch {
    // The scan could not be recorded. Details stay out of the response and the logs, since storage errors can carry internals.
    console.error("monitor: state store unavailable");
    return NextResponse.json({ error: "Monitoring store unavailable; this scan was not recorded." }, { status: 503 });
  }
}
