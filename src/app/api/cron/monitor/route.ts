import { NextResponse, type NextRequest } from "next/server";
import { cronAuthorised } from "@/lib/monitor/auth";
import { runScan } from "@/lib/monitor/run";
import { blobStore } from "@/lib/monitor/store";
import { notifyRun, type NotifyReport } from "@/lib/push/notify";
import { vapidConfig } from "@/lib/push/send";
import { blobDeliveryStore, blobPushStore } from "@/lib/push/store";
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
    // The scan is already saved. Notifying is a separate step: its failure is reported, never folded into the scan.
    let push: NotifyReport | { status: "error" };
    try {
      push = await notifyRun(r.run, r.added, { subs: blobPushStore, deliveries: blobDeliveryStore, vapid: vapidConfig() });
      console.log(`push: digest ${push.status}, ${push.events} qualifying, ${push.eligible} opted in, ${push.sent} sent, ${push.failed} failed, ${push.expired} expired, ${push.notAttempted} not attempted`);
    } catch (e) {
      push = { status: "error" };
      console.error(`push: digest delivery failed: ${e instanceof Error ? e.name : "unknown"}`);
    }
    return NextResponse.json({ outcome: r.outcome, run: r.run, push }, { status: r.run.status === "failed" ? 502 : 200 });
  } catch (e) {
    // The scan could not be recorded. The caller learns nothing more; the log gets the error class and SDK message only.
    console.error(`monitor: state store unavailable: ${e instanceof Error ? `${e.name}: ${e.message.slice(0, 140)}` : "unknown"}`);
    return NextResponse.json({ error: "Monitoring store unavailable; this scan was not recorded." }, { status: 503 });
  }
}
