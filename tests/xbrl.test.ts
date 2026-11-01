import { describe, expect, it } from "vitest";
import { classifyEntity, parseResults } from "@/lib/sources/xbrl";

// Mirrors the real NSE file shape, including the legacy quirk: FourD's context carries the quarter's
// dates while its DateOfStart fact shows it is year-to-date.
const f = (t: string, c: string, v: string) => `<in-capmkt:${t} contextRef="${c}" unitRef="INR">${v}</in-capmkt:${t}>`;
const legacy = [
  f("DateOfStartOfReportingPeriod", "OneD", "2024-10-01"), f("DateOfEndOfReportingPeriod", "OneD", "2024-12-31"),
  f("DateOfStartOfReportingPeriod", "FourD", "2024-04-01"), f("DateOfEndOfReportingPeriod", "FourD", "2024-12-31"),
  f("NatureOfReportStandaloneConsolidated", "OneD", "Standalone"), f("NatureOfReportStandaloneConsolidated", "FourD", "Standalone"),
  f("RevenueFromOperations", "OneD", "9391712000.00"), f("RevenueFromOperations", "FourD", "28207127000.00"),
  f("OtherIncome", "OneD", "398536000.00"), f("Expenses", "OneD", "7231760000.00"),
  f("FinanceCosts", "OneD", "46503000.00"), f("DepreciationDepletionAndAmortisationExpense", "OneD", "259672000.00"),
  f("ProfitBeforeTax", "OneD", "2558488000.00"), f("ProfitLossForPeriod", "OneD", "1990064000.00"),
  f("LevelOfRoundingUsedInFinancialStatements", "OneD", "Lakhs"),
  `<in-capmkt:RevenueFromOperations contextRef="OneOperatingExpenses01D">1</in-capmkt:RevenueFromOperations>`,
].join("\n");
const meta = { url: "https://x/INDAS_1.xml", filedAt: null, audited: "Audited", entityClass: "operating" as const };

describe("XBRL results", () => {
  it("returns the quarter only and ignores the YTD column", () => {
    const r = parseResults(legacy, meta);
    expect(r).toHaveLength(1);
    expect(r[0].label).toBe("Q3 FY25");
    expect(r[0].revenue).toBe(9391712000);
  });
  it("derives EBITDA excluding other income, and it reconciles to PBT", () => {
    const [r] = parseResults(legacy, meta);
    expect(r.ebitda).toBe(9391712000 - (7231760000 - 46503000 - 259672000));
    expect(r.ebitda! + 398536000 - 46503000 - 259672000).toBe(2558488000);
  });
  it("reads values as absolute INR regardless of the rounding label", () => {
    expect(parseResults(legacy, meta)[0].pat).toBe(1990064000);
  });
  it("leaves EBITDA null when an input is absent, never zero", () => {
    const [r] = parseResults(legacy.replace(/.*FinanceCosts.*\n?/g, ""), meta);
    expect(r.ebitda).toBeNull();
    expect(r.financeCosts).toBeNull();
  });
  it("gives lenders no EBITDA", () => {
    const [r] = parseResults(legacy, { ...meta, entityClass: "nbfc" });
    expect(r.ebitda).toBeNull();
    expect(r.pat).toBe(1990064000);
  });
  it("uses bank tags and computes NII", () => {
    const bank = [
      f("DateOfStartOfReportingPeriod", "OneD", "2026-01-01"), f("DateOfEndOfReportingPeriod", "OneD", "2026-03-31"),
      f("NatureOfReportStandaloneConsolidated", "OneD", "Consolidated"),
      f("InterestEarned", "OneD", "1000"), f("InterestExpended", "OneD", "600"), f("Income", "OneD", "1300"),
      f("OperatingProfitBeforeProvisionAndContingencies", "OneD", "300"),
      f("ProfitLossFromOrdinaryActivitiesBeforeTax", "OneD", "250"),
      f("ProfitLossAfterTaxesMinorityInterestAndShareOfProfitLossOfAssociates", "OneD", "190"),
    ].join("");
    const [r] = parseResults(bank, { ...meta, entityClass: "bank" });
    expect(r).toMatchObject({ entityClass: "bank", nii: 400, ppop: 300, pat: 190, ebitda: null, revenueLabel: "Total income", basis: "consolidated" });
  });
  it("captures a full-year column from a March filing", () => {
    const x = [
      f("DateOfStartOfReportingPeriod", "OneD", "2026-01-01"), f("DateOfEndOfReportingPeriod", "OneD", "2026-03-31"),
      f("DateOfStartOfReportingPeriod", "FourD", "2025-04-01"), f("DateOfEndOfReportingPeriod", "FourD", "2026-03-31"),
      f("NatureOfReportStandaloneConsolidated", "OneD", "Consolidated"), f("NatureOfReportStandaloneConsolidated", "FourD", "Consolidated"),
      f("RevenueFromOperations", "OneD", "10"), f("RevenueFromOperations", "FourD", "40"),
    ].join("");
    expect(parseResults(x, meta).map((p) => [p.kind, p.label, p.revenue])).toEqual([["Q", "Q4 FY26", 10], ["FY", "FY26", 40]]);
  });
  it("classifies entities", () => {
    expect(classifyEntity("x/BANKING_1.xml")).toBe("bank");
    expect(classifyEntity("x/INDAS_1.xml", "Non Banking Financial Company (NBFC)")).toBe("nbfc");
    expect(classifyEntity("x/INDAS_1.xml", "IT - Software")).toBe("operating");
  });
});
