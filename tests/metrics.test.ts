import { describe, expect, it } from "vitest";
import { comparePeriods, evaluateSignals, fiscalLabel, marginPct, pctChange, priorQuarterEnd, volumeMultiple, yearAgoEnd } from "@/lib/domain/metrics";
import type { Bar, PeriodFacts } from "@/lib/domain/types";

const bars = (vols: number[], closes?: number[]): Bar[] =>
  vols.map((v, i) => ({ date: `d${i}`, volume: v, close: closes?.[i] ?? 100 }));

describe("volume multiple", () => {
  it("excludes the current session from the mean", () => {
    const b = bars([...Array(20).fill(100), 300]);
    expect(volumeMultiple(b)).toBe(3); // would be 2.86 if today were in the mean
  });
  it("uses only the preceding 20 sessions", () => {
    const b = bars([9999, ...Array(20).fill(100), 200]);
    expect(volumeMultiple(b)).toBe(2);
  });
  it("is null without 20 prior sessions", () => {
    expect(volumeMultiple(bars([...Array(19).fill(100), 300]))).toBeNull();
  });
  it("is null on zero mean volume", () => {
    expect(volumeMultiple(bars([...Array(20).fill(0), 300]))).toBeNull();
  });
});

describe("pct and margin", () => {
  it("computes change", () => expect(pctChange(110, 100)).toBe(10));
  it("treats missing as null, never zero", () => {
    expect(pctChange(null, 100)).toBeNull();
    expect(pctChange(100, null)).toBeNull();
    expect(marginPct(null, 100)).toBeNull();
  });
  it("refuses growth off a loss or zero base", () => {
    expect(pctChange(50, -20)).toBeNull();
    expect(pctChange(50, 0)).toBeNull();
  });
  it("keeps a reported zero as zero", () => expect(pctChange(0, 100)).toBe(-100));
});

describe("signals", () => {
  it("fires price and volume beyond thresholds only", () => {
    const closes = [...Array(21).fill(100), 104, 104.5];
    const b = bars([...Array(21).fill(100), 100, 500], closes);
    const ev = evaluateSignals(b, { pricePct: 3, volumeMultiple: 2 }, 2);
    expect(ev.map((e) => `${e.date}:${e.type}`)).toEqual(["d22:volume", "d21:price"]);
    expect(ev[1].value).toBe(4);
  });
  it("catches negative moves", () => {
    const ev = evaluateSignals(bars([...Array(22).fill(1)], [...Array(21).fill(100), 90]), { pricePct: 5, volumeMultiple: 9 }, 1);
    expect(ev[0].value).toBe(-10);
  });
});

const q = (end: string, revenue: number | null, over: Partial<PeriodFacts> = {}): PeriodFacts => ({
  kind: "Q", label: fiscalLabel(end, "Q"), periodStart: "", periodEnd: end, basis: "consolidated", entityClass: "operating",
  revenue, revenueLabel: "Revenue", otherIncome: null, financeCosts: null, depreciation: null, totalExpenses: null,
  pbt: null, pat: null, ebitda: null, ebit: null, nii: null, ppop: null, cfo: null, capex: null, borrowings: null, equity: null,
  audited: null, source: { url: "u", title: "t", docType: "xbrl_results" }, ...over,
});

describe("period comparison", () => {
  const series = [q("2026-09-30", 150), q("2026-06-30", 120), q("2026-03-31", 110), q("2025-12-31", 105), q("2025-09-30", 100)];
  it("YoY uses the same quarter a year ago, not the previous quarter", () => {
    const c = comparePeriods(series, "2026-09-30", "revenue");
    expect(c.qoq).toBe(25);
    expect(c.yoy).toBe(50);
    expect(c.yoyLabel).toBe("Q2 FY26");
    expect(c.prevLabel).toBe("Q1 FY27");
  });
  it("does not substitute when the year-ago quarter is missing", () => {
    const c = comparePeriods(series.slice(0, 3), "2026-09-30", "revenue");
    expect(c.yoy).toBeNull();
    expect(c.qoq).toBe(25);
  });
  it("matches by date when a quarter is skipped in the series", () => {
    const c = comparePeriods([series[0], series[2], series[4]], "2026-09-30", "revenue");
    expect(c.qoq).toBeNull();
    expect(c.yoy).toBe(50);
  });
  it("refuses to mix bases", () => {
    expect(() => comparePeriods([series[0], { ...series[1], basis: "standalone" }], "2026-09-30", "revenue")).toThrow();
  });
  it("refuses to mix quarterly and annual", () => {
    expect(() => comparePeriods([series[0], { ...series[1], kind: "FY" }], "2026-09-30", "revenue")).toThrow();
  });
  it("handles quarter-end arithmetic", () => {
    expect(priorQuarterEnd("2026-03-31")).toBe("2025-12-31");
    expect(priorQuarterEnd("2026-06-30")).toBe("2026-03-31");
    expect(yearAgoEnd("2024-03-31")).toBe("2023-03-31");
  });
  it("labels Indian fiscal periods", () => {
    expect(fiscalLabel("2026-09-30", "Q")).toBe("Q2 FY27");
    expect(fiscalLabel("2026-03-31", "Q")).toBe("Q4 FY26");
    expect(fiscalLabel("2026-03-31", "FY")).toBe("FY26");
    expect(fiscalLabel("2025-12-31", "Q")).toBe("Q3 FY26");
  });
});
