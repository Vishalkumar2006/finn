export type DataMode = "live" | "cache" | "snapshot";

/** Every API payload says where its data came from and how old it is. */
export interface Provenance {
  source: string;
  fetchedAt: string;
  mode: DataMode;
  note?: string;
}

export type Basis = "consolidated" | "standalone";
export type EntityClass = "operating" | "bank" | "nbfc";

export interface SourceRef {
  url: string;
  title: string;
  docType: "xbrl_results" | "transcript" | "annual_report" | "exchange_filing";
  period?: string;
  filedAt?: string;
  basis?: Basis;
  page?: number;
  excerpt?: string;
}

/** One reporting period for one basis, as filed. All money is absolute INR; null = not filed. */
export interface PeriodFacts {
  kind: "Q" | "FY";
  label: string;
  periodStart: string;
  periodEnd: string;
  basis: Basis;
  entityClass: EntityClass;
  revenue: number | null;
  revenueLabel: string;
  otherIncome: number | null;
  financeCosts: number | null;
  depreciation: number | null;
  totalExpenses: number | null;
  pbt: number | null;
  pat: number | null;
  ebitda: number | null;
  ebit: number | null;
  nii: number | null;
  ppop: number | null;
  cfo: number | null;
  capex: number | null;
  borrowings: number | null;
  equity: number | null;
  audited: string | null;
  source: SourceRef;
}

export interface Bar {
  date: string;
  close: number;
  volume: number;
}

export const CATEGORIES = [
  "results", "M&A", "fund_raise", "management_change", "litigation", "insider_trading",
  "earnings_call", "investor_meetings", "credit_rating", "dividend", "bonus_split", "capex",
  "press_release", "postal_ballot", "agm_egm", "pledging", "unclassified",
] as const;
export type Category = (typeof CATEGORIES)[number];
export type Priority = "critical" | "notable" | "routine";

export interface RawAnnouncement {
  symbol: string;
  company: string;
  industry?: string;
  desc: string;
  text: string;
  at: string; // ISO with +05:30
  url: string | null;
  seqId: string;
}

export interface BriefItem extends RawAnnouncement {
  category: Category;
  priority: Priority;
  why: string;
  summary: string;
  related: { desc: string; at: string; url: string | null; seqId: string }[];
}

export type GuidanceMetric =
  | "revenue_growth" | "revenue_abs" | "ebitda_growth" | "pat_growth"
  | "ebitda_margin" | "ebit_margin" | "pat_margin" | "capex" | "other";
export type GuidanceStatus = "exceeded" | "met" | "missed" | "not_yet" | "insufficient";

export interface FiscalPeriod {
  kind: "Q" | "FY";
  fy: number;
  q?: number;
}

export interface GuidanceClaim {
  metric: GuidanceMetric;
  low: number | null;
  high: number | null;
  unit: "%" | "INR" | null;
  floor: boolean;
  period: FiscalPeriod | null;
  periodText: string | null;
  periodInferred: boolean;
  comparison: "yoy" | "qoq" | null;
  basisNote: string | null; // e.g. constant currency, a segment; blocks comparison
  quote: string;
  speaker: string;
  page: number;
}
