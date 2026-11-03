import { NextResponse, type NextRequest } from "next/server";
import { cronAuthorised } from "@/lib/monitor/auth";
import { runScan } from "@/lib/monitor/run";
import { blobStore } from "@/lib/monitor/store";
import type { RunRecord } from "@/lib/domain/monitor";
import type { Bar, RawAnnouncement } from "@/lib/domain/types";
import { notifyPersonal, notifyRun, type NotifyReport, type PersonalReport } from "@/lib/push/notify";
import { extraSymbols, LIMITS } from "@/lib/push/personal";
import { mapLimit } from "@/lib/sources/http";
import { vapidConfig } from "@/lib/push/send";
import { blobDeliveryStore, blobPushStore } from "@/lib/push/store";
import { DEFAULT_PORTFOLIO, MONITOR_RULE } from "@/lib/portfolio";
import { fetchAnnouncements } from "@/lib/sources/nse";
import { fetchHistory } from "@/lib/sources/yahoo";

export const maxDuration = 120;

/** Prices companies that only personal rules ask for (capped, 4 at a time, one retry), then matches every device. */
async function personalPass(run: RunRecord, filings: RawAnnouncement[] | null, bars: Map<string, Bar[] | null>): Promise<PersonalReport> {
  const subs = (await blobPushStore.read())?.doc.subscriptions ?? [];
  const extra = extraSymbols(subs, DEFAULT_PORTFOLIO.map((p) => p.symbol)).slice(0, LIMITS.extraSymbols);
  await mapLimit(extra, 4, async (symbol) => {
    for (let i = 0; i < 2; i++) {
      try {
        const b = (await fetchHistory(symbol)).bars;
        if (b.length) return void bars.set(symbol, b);
      } catch {}
    }
    bars.set(symbol, null);
  });
  return notifyPersonal(run, { startedAt: run.startedAt, filings, bars }, { subs: blobPushStore, deliveries: blobDeliveryStore, vapid: vapidConfig() });
}

export async function GET(req: NextRequest) {
  if (!cronAuthorised(req.headers.get("authorization"), process.env.CRON_SECRET)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const trigger = req.headers.get("x-vercel-cron-schedule") || req.headers.get("user-agent")?.startsWith("vercel-cron") ? "cron" : "manual";
  // What the shared scan read, kept so personal rules reuse it: one market-wide filings call, one price call per symbol.
  let filings: RawAnnouncement[] | null = null;
  const bars = new Map<string, Bar[] | null>();
  try {
    const r = await runScan({
      store: blobStore,
      symbols: DEFAULT_PORTFOLIO.map((p) => p.symbol),
      rule: MONITOR_RULE,
      fetchFilings: async (from, to) => {
        const f = await fetchAnnouncements(from, to);
        filings = f.length ? f : null; // the scan treats an empty market-wide feed as a failed read; so does this
        return f;
      },
      fetchBars: async (symbol) => {
        const b = (await fetchHistory(symbol)).bars;
        bars.set(symbol, b);
        return b;
      },
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
    let personal: PersonalReport | { status: "error" };
    try {
      personal = await personalPass(r.run, filings, bars);
      console.log(`push: personal ${personal.status}, ${personal.devices} devices, ${personal.matched} matched, ${personal.sent} sent, ${personal.failed} failed, ${personal.expired} expired, ${personal.notAttempted} not attempted, ${personal.unchecked.length} symbols unread, filings ${personal.filingsRead ? "read" : "not read"}`);
    } catch (e) {
      personal = { status: "error" };
      console.error(`push: personal monitoring failed: ${e instanceof Error ? e.name : "unknown"}`);
    }
    return NextResponse.json({ outcome: r.outcome, run: r.run, push, personal }, { status: r.run.status === "failed" ? 502 : 200 });
  } catch (e) {
    // The scan could not be recorded. The caller learns nothing more; the log gets the error class and SDK message only.
    console.error(`monitor: state store unavailable: ${e instanceof Error ? `${e.name}: ${e.message.slice(0, 140)}` : "unknown"}`);
    return NextResponse.json({ error: "Monitoring store unavailable; this scan was not recorded." }, { status: 503 });
  }
}
