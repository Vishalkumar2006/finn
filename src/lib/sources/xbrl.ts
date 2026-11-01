import { fiscalLabel } from "../domain/metrics";
import type { Basis, EntityClass, PeriodFacts, SourceRef } from "../domain/types";

type Facts = Map<string, string>;

/** Non-dimensional facts for each root context (OneD, FourD, OneI). Regex is enough: the files are flat. */
export function readFacts(xml: string): Record<string, Facts> {
  const out: Record<string, Facts> = {};
  const re = /<[A-Za-z0-9_-]+:([A-Za-z0-9_]+)\s+[^>]*contextRef="(OneD|TwoD|ThreeD|FourD|OneI)"[^>]*>([^<]*)</g;
  for (const m of xml.matchAll(re)) {
    (out[m[2]] ??= new Map()).set(m[1], m[3].trim());
  }
  return out;
}

function days(a: string, b: string) {
  return (Date.parse(b) - Date.parse(a)) / 86400000;
}

export interface XbrlMeta {
  url: string;
  filedAt: string | null;
  audited: string | null;
  entityClass: EntityClass;
}

/**
 * Parse a results filing into quarterly and full-year facts.
 * Legacy NSE files stamp the year-to-date context with the quarter's dates, so the period is read from the
 * DateOfStart/End facts and never from the context element.
 */
export function parseResults(xml: string, meta: XbrlMeta): PeriodFacts[] {
  const ctx = readFacts(xml);
  const out: PeriodFacts[] = [];
  for (const id of ["OneD", "TwoD", "ThreeD", "FourD"]) {
    const f = ctx[id];
    if (!f) continue;
    const start = f.get("DateOfStartOfReportingPeriod");
    const end = f.get("DateOfEndOfReportingPeriod");
    if (!start || !end) continue;
    const span = days(start, end);
    const kind = span >= 85 && span <= 95 ? "Q" : span >= 360 && span <= 370 ? "FY" : null;
    if (!kind) continue; // half-year and nine-month columns are not used
    const nature = (f.get("NatureOfReportStandaloneConsolidated") ?? ctx.OneD?.get("NatureOfReportStandaloneConsolidated") ?? "").toLowerCase();
    if (nature !== "standalone" && nature !== "consolidated") continue;
    out.push(toFacts(f, ctx.OneI, kind, start, end, nature as Basis, meta));
  }
  return out;
}

function num(f: Facts | undefined, ...tags: string[]): number | null {
  if (!f) return null;
  for (const t of tags) {
    const v = f.get(t);
    if (v == null || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function sum(...vals: (number | null)[]): number | null {
  return vals.every((v) => v == null) ? null : vals.reduce<number>((a, b) => a + (b ?? 0), 0);
}

function toFacts(
  f: Facts, inst: Facts | undefined, kind: "Q" | "FY", start: string, end: string, basis: Basis, meta: XbrlMeta,
): PeriodFacts {
  const isBank = f.has("InterestEarned") || meta.entityClass === "bank";
  const entityClass: EntityClass = isBank ? "bank" : meta.entityClass;
  const label = fiscalLabel(end, kind);
  const source: SourceRef = {
    url: meta.url, title: `NSE XBRL results, ${label}, ${basis}`, docType: "xbrl_results",
    period: label, filedAt: meta.filedAt ?? undefined, basis,
  };
  const expenses = num(f, "Expenses");
  const finance = num(f, "FinanceCosts");
  const dep = num(f, "DepreciationDepletionAndAmortisationExpense");
  const base = {
    kind, label, periodStart: start, periodEnd: end, basis, entityClass,
    otherIncome: num(f, "OtherIncome"), financeCosts: finance, depreciation: dep, totalExpenses: expenses,
    audited: meta.audited, source,
    borrowings: num(inst, "Borrowings") ?? sum(num(inst, "BorrowingsNoncurrent"), num(inst, "BorrowingsCurrent")),
    equity: num(inst, "Equity"),
    cfo: kind === "FY" ? num(f, "CashFlowsFromUsedInOperatingActivities") : null,
    capex: kind === "FY" ? num(f, "PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities") : null,
  };
  if (isBank) {
    const earned = num(f, "InterestEarned");
    const expended = num(f, "InterestExpended");
    return {
      ...base,
      revenue: num(f, "Income"), revenueLabel: "Total income",
      pbt: num(f, "ProfitLossFromOrdinaryActivitiesBeforeTax"),
      pat: num(f, "ProfitLossAfterTaxesMinorityInterestAndShareOfProfitLossOfAssociates", "ProfitLossForThePeriod"),
      ebitda: null, ebit: null,
      nii: earned != null && expended != null ? earned - expended : null,
      ppop: num(f, "OperatingProfitBeforeProvisionAndContingencies"),
    };
  }
  const revenue = num(f, "RevenueFromOperations");
  // EBITDA = revenue from operations − operating costs. Excludes other income and exceptional items.
  // Not meaningful for lenders, whose finance cost is effectively their cost of goods.
  const canDerive = entityClass === "operating" && revenue != null && expenses != null && finance != null && dep != null;
  const ebitda = canDerive ? revenue! - (expenses! - finance! - dep!) : null;
  return {
    ...base,
    revenue, revenueLabel: "Revenue from operations",
    pbt: num(f, "ProfitBeforeTax"),
    pat: num(f, "ProfitLossForPeriod"),
    ebitda, ebit: ebitda != null ? ebitda - dep! : null,
    nii: null, ppop: null,
  };
}

const FIN = /\b(nbfc|finance|financial services|housing finance|insurance|asset management)\b/i;

export function classifyEntity(fileUrl: string, industry?: string): EntityClass {
  if (/BANKING/i.test(fileUrl)) return "bank";
  if (/NBFC|INSURANCE/i.test(fileUrl) || (industry && FIN.test(industry))) return "nbfc";
  return "operating";
}
