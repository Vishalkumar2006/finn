import type { Bar, PeriodFacts } from "./types";

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/** % change. Null if either side is missing or the base is non-positive (growth off a loss is meaningless). */
export function pctChange(current: number | null | undefined, base: number | null | undefined): number | null {
  if (current == null || base == null || base <= 0) return null;
  return round(((current - base) / base) * 100);
}

export function marginPct(part: number | null | undefined, whole: number | null | undefined): number | null {
  if (part == null || whole == null || whole <= 0) return null;
  return round((part / whole) * 100);
}

export function ratio(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null || b == null || b === 0) return null;
  return round(a / b);
}

/** Today's volume ÷ mean of the preceding `lookback` sessions, excluding today. Null without full history. */
export function volumeMultiple(bars: Bar[], index = bars.length - 1, lookback = 20): number | null {
  if (index < lookback || index >= bars.length) return null;
  const prior = bars.slice(index - lookback, index).map((b) => b.volume);
  if (prior.some((v) => v == null)) return null;
  const mean = prior.reduce((a, b) => a + b, 0) / lookback;
  if (mean <= 0 || bars[index].volume == null) return null;
  return round(bars[index].volume / mean);
}

export function priceMovePct(bars: Bar[], index = bars.length - 1): number | null {
  if (index < 1 || index >= bars.length) return null;
  return pctChange(bars[index].close, bars[index - 1].close);
}

export interface SignalRule {
  pricePct: number;
  volumeMultiple: number;
}

export interface SignalEvent {
  date: string;
  type: "price" | "volume";
  value: number;
  threshold: number;
  close: number;
  volume: number;
}

/** Deterministic threshold evaluation over the last `sessions` sessions. Strictly beyond the threshold fires. */
export function evaluateSignals(bars: Bar[], rule: SignalRule, sessions = 5): SignalEvent[] {
  const out: SignalEvent[] = [];
  for (let i = Math.max(1, bars.length - sessions); i < bars.length; i++) {
    const b = bars[i];
    const move = priceMovePct(bars, i);
    if (move != null && Math.abs(move) > rule.pricePct)
      out.push({ date: b.date, type: "price", value: move, threshold: rule.pricePct, close: b.close, volume: b.volume });
    const vm = volumeMultiple(bars, i);
    if (vm != null && vm > rule.volumeMultiple)
      out.push({ date: b.date, type: "volume", value: vm, threshold: rule.volumeMultiple, close: b.close, volume: b.volume });
  }
  return out.reverse();
}

/* ---- period comparison: matched on actual dates, never on array position ---- */

function shiftEnd(iso: string, months: number): string {
  const [y, m] = iso.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + months + 1, 0)); // last day of the target month
  return d.toISOString().slice(0, 10);
}

export const priorQuarterEnd = (periodEnd: string) => shiftEnd(periodEnd, -3);
export const yearAgoEnd = (periodEnd: string) => shiftEnd(periodEnd, -12);

export function fiscalLabel(periodEnd: string, kind: "Q" | "FY"): string {
  const [y, m] = periodEnd.split("-").map(Number);
  const fy = m >= 4 ? y + 1 : y;
  const yy = String(fy % 100).padStart(2, "0");
  if (kind === "FY") return `FY${yy}`;
  const q = m >= 4 ? Math.ceil((m - 3) / 3) : 4;
  return `Q${q} FY${yy}`;
}

export type MetricKey = "revenue" | "ebitda" | "ebit" | "pbt" | "pat" | "nii" | "ppop";

export interface Compared {
  metric: MetricKey;
  value: number | null;
  qoq: number | null;
  yoy: number | null;
  prevLabel: string | null;
  yoyLabel: string | null;
}

/** QoQ and YoY for one period. Series must be one basis and one kind; comparison periods are found by date. */
export function comparePeriods(series: PeriodFacts[], periodEnd: string, metric: MetricKey): Compared {
  const cur = series.find((p) => p.periodEnd === periodEnd);
  if (!cur) return { metric, value: null, qoq: null, yoy: null, prevLabel: null, yoyLabel: null };
  for (const p of series) {
    if (p.basis !== cur.basis || p.kind !== cur.kind) throw new Error("comparePeriods: mixed basis or period kind");
  }
  const prev = cur.kind === "Q" ? series.find((p) => p.periodEnd === priorQuarterEnd(periodEnd)) : undefined;
  const ya = series.find((p) => p.periodEnd === yearAgoEnd(periodEnd));
  return {
    metric,
    value: cur[metric],
    qoq: prev ? pctChange(cur[metric], prev[metric]) : null,
    yoy: ya ? pctChange(cur[metric], ya[metric]) : null,
    prevLabel: prev?.label ?? null,
    yoyLabel: ya?.label ?? null,
  };
}
