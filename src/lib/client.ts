"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { CATEGORIES, type Category } from "./domain/types";
import { DEFAULT_PORTFOLIO, MONITOR_RULE } from "./portfolio";

/* ---------- settings: per-device, in localStorage ---------- */

export interface Settings {
  symbols: string[];
  names: Record<string, string>;
  pricePct: number;
  volumeMultiple: number;
  categories: Category[];
  readAlerts: string[];
}

const DEFAULTS: Settings = {
  symbols: DEFAULT_PORTFOLIO.map((p) => p.symbol),
  names: Object.fromEntries(DEFAULT_PORTFOLIO.map((p) => [p.symbol, p.name])),
  pricePct: MONITOR_RULE.pricePct,
  volumeMultiple: MONITOR_RULE.volumeMultiple,
  categories: ["results", "M&A", "management_change", "litigation", "pledging"],
  readAlerts: [],
};

const KEY = "finn.settings.v1";
let current: Settings | null = null;
const listeners = new Set<() => void>();

function load(): Settings {
  if (current) return current;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Settings>) : {};
    current = { ...DEFAULTS, ...parsed, categories: (parsed.categories ?? DEFAULTS.categories).filter((c) => CATEGORIES.includes(c)) };
  } catch {
    current = DEFAULTS;
  }
  return current;
}

export function updateSettings(patch: Partial<Settings>) {
  current = { ...load(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Private mode or blocked storage: settings last for this page view only.
  }
  listeners.forEach((l) => l());
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    load,
    () => DEFAULTS,
  );
}

/** Page-load time, browser only. 0 during prerender, so nothing time-dependent is baked into static HTML. */
let pageLoad = 0;
export function useNow(): number {
  return useSyncExternalStore(
    () => () => {},
    () => (pageLoad ||= Date.now()),
    () => 0,
  );
}

/* ---------- fetch hook ---------- */

export interface Remote<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

export function useApi<T>(url: string | null): Remote<T> {
  const [state, setState] = useState<{ url: string | null; data: T | null; error: string | null; done: boolean }>({ url: null, data: null, error: null, done: false });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!url) return;
    let live = true;
    fetch(url)
      .then(async (r) => {
        const j = await r.json().catch(() => null);
        if (!r.ok) throw new Error((j as { error?: string } | null)?.error ?? `Request failed (${r.status})`);
        return j as T;
      })
      .then((data) => live && setState({ url, data, error: null, done: true }))
      .catch((e: Error) => live && setState({ url, data: null, error: e.message || "Network error", done: true }));
    return () => {
      live = false;
    };
  }, [url, tick]);
  const reload = useCallback(() => {
    setState((s) => ({ ...s, done: false, url: null }));
    setTick((t) => t + 1);
  }, []);
  const current = state.url === url && state.done;
  return { data: current ? state.data : null, error: current ? state.error : null, loading: Boolean(url) && !current, reload };
}

/* ---------- formatting ---------- */

const IST = "Asia/Kolkata";

export function fmtCr(v: number | null | undefined): string {
  if (v == null) return "—";
  const cr = v / 1e7;
  const abs = Math.abs(cr);
  return cr.toLocaleString("en-IN", { maximumFractionDigits: abs >= 1000 ? 0 : 1, minimumFractionDigits: abs >= 1000 ? 0 : 1 });
}

export const fmtPct = (v: number | null | undefined) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`);

export const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso.length === 10 ? `${iso}T12:00:00+05:30` : iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: IST }) : "—";

export const fmtTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true, timeZone: IST }).replace(/ (am|pm)$/i, (m) => m.toLowerCase()) : "—";

export const CATEGORY_LABEL: Record<Category, string> = {
  results: "Results", "M&A": "M&A", fund_raise: "Fund raise", management_change: "Management change", litigation: "Litigation",
  insider_trading: "Insider trade", earnings_call: "Earnings call", investor_meetings: "Investor meeting", credit_rating: "Credit rating",
  dividend: "Dividend", bonus_split: "Bonus / split", capex: "Capex", press_release: "Press release", postal_ballot: "Postal ballot",
  agm_egm: "AGM / EGM", pledging: "Pledging", unclassified: "Routine",
};
