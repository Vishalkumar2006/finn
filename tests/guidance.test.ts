import { describe, expect, it } from "vitest";
import { evaluateClaim, extractClaims, managementSpeakers, parsePeriod, parseTurns, parseValue } from "@/lib/domain/guidance";
import { chunkPages, search, supported, unverifiedNumbers } from "@/lib/domain/retrieval";
import { canonicalUrl, parseDocuments } from "@/lib/sources/screener";
import { fiscalLabel } from "@/lib/domain/metrics";
import type { GuidanceClaim, PeriodFacts } from "@/lib/domain/types";

const facts = (end: string, kind: "Q" | "FY", revenue: number, ebitda: number | null): PeriodFacts => ({
  kind, label: fiscalLabel(end, kind), periodStart: "", periodEnd: end, basis: "consolidated", entityClass: "operating",
  revenue, revenueLabel: "Revenue from operations", otherIncome: null, financeCosts: null, depreciation: null, totalExpenses: null,
  pbt: null, pat: 50, ebitda, ebit: null, nii: null, ppop: null, cfo: null, capex: null, borrowings: null, equity: null,
  audited: null, source: { url: "https://x/f.xml", title: "t", docType: "xbrl_results" },
});
const series = [facts("2026-03-31", "FY", 1000, 138.5), facts("2025-03-31", "FY", 800, 100)];
const claim = (o: Partial<GuidanceClaim>): GuidanceClaim => ({
  metric: "ebitda_margin", low: 14.5, high: 15, unit: "%", floor: false, period: { kind: "FY", fy: 2026 }, periodText: "full year",
  periodInferred: false, comparison: null, basisNote: null, quote: "q", speaker: "s", page: 1, ...o,
});

describe("guidance evaluation", () => {
  it("misses below a range and reports the variance", () => {
    const e = evaluateClaim(claim({}), series, "2026-03-31");
    expect(e).toMatchObject({ status: "missed", variance: -0.65 });
    expect(e.actual?.value).toBe(13.85);
  });
  it("meets inside a range", () => {
    expect(evaluateClaim(claim({ low: 13, high: 14 }), series, "2026-03-31").status).toBe("met");
  });
  it("exceeds above a range", () => {
    expect(evaluateClaim(claim({ low: 10, high: 12 }), series, "2026-03-31")).toMatchObject({ status: "exceeded", variance: 1.85 });
  });
  it("treats a floor as met when beaten", () => {
    expect(evaluateClaim(claim({ low: 10, high: null, floor: true }), series, "2026-03-31").status).toBe("met");
  });
  it("is not yet evaluable before the period is reported", () => {
    expect(evaluateClaim(claim({ period: { kind: "FY", fy: 2027 } }), series, "2026-03-31").status).toBe("not_yet");
  });
  it("abstains without a period, without a number, or without a mapped metric", () => {
    expect(evaluateClaim(claim({ period: null }), series, "2026-03-31").status).toBe("insufficient");
    expect(evaluateClaim(claim({ low: null, high: null, unit: null }), series, "2026-03-31").status).toBe("insufficient");
    expect(evaluateClaim(claim({ metric: "other" }), series, "2026-03-31").status).toBe("insufficient");
  });
  it("refuses constant-currency guidance against INR actuals", () => {
    const e = evaluateClaim(claim({ basisNote: "Guided in constant currency; filings report in INR." }), series, "2026-03-31");
    expect(e.status).toBe("insufficient");
    expect(e.actual).toBeNull();
  });
  it("computes growth from the year-ago period", () => {
    const e = evaluateClaim(claim({ metric: "revenue_growth", low: 20, high: 22, comparison: "yoy" }), series, "2026-03-31");
    expect(e.status).toBe("exceeded");
    expect(e.actual?.value).toBe(25); // 1000 vs 800
    expect(e.variance).toBe(3);
  });
  it("does not evaluate when the comparison year is absent", () => {
    const e = evaluateClaim(claim({ metric: "revenue_growth", comparison: "yoy" }), [series[0]], "2026-03-31");
    expect(e.status).toBe("insufficient");
  });
  // Regression from a real transcript: a Rs 550 crore product-line target must not be scored against company revenue.
  it("refuses a rupee target out of scale with company revenue", () => {
    const big = [facts("2026-03-31", "FY", 117477650000, null)];
    const e = evaluateClaim(claim({ metric: "revenue_abs", low: 5.5e9, high: 6e9, unit: "INR" }), big, "2026-03-31");
    expect(e.status).toBe("insufficient");
  });
});

describe("guidance parsing", () => {
  it("reads ranges and floors", () => {
    expect(parseValue("EBITDA margin between 14.5% to 15%")).toMatchObject({ low: 14.5, high: 15, unit: "%" });
    expect(parseValue("at least 12% growth")).toMatchObject({ low: 12, high: null, floor: true });
    expect(parseValue("double-digit growth")).toMatchObject({ low: 10, floor: true });
  });
  it("reads crore ranges in either phrasing", () => {
    expect(parseValue("top line of close to Rs.550 crores to Rs.600 crores")).toMatchObject({ low: 5.5e9, high: 6e9, unit: "INR" });
    expect(parseValue("around INR 1,500 to 2,000 crores")).toMatchObject({ low: 1.5e10, high: 2e10 });
  });
  it("does not read a fiscal year as a number", () => {
    expect(parseValue("we will do well in FY27").low).toBeNull();
  });
  it("resolves relative periods against the call date", () => {
    expect(parsePeriod("for the full year", "2025-10-20").period).toEqual({ kind: "FY", fy: 2026 });
    expect(parsePeriod("for the full year", "2026-05-10").period).toEqual({ kind: "FY", fy: 2027 });
    expect(parsePeriod("next year", "2025-10-20").period).toEqual({ kind: "FY", fy: 2027 });
    expect(parsePeriod("next quarter", "2026-01-20").period).toEqual({ kind: "Q", fy: 2026, q: 4 });
    expect(parsePeriod("Q3 FY27 should improve", "2026-10-20").period).toEqual({ kind: "Q", fy: 2027, q: 3 });
    expect(parsePeriod("nothing here", "2026-10-20").period).toBeNull();
  });
  it("does not mistake the call's own quarter for the target", () => {
    expect(parsePeriod("during Q4 FY'25 earnings call, we guided for FY'26", "2025-07-20").period).toEqual({ kind: "FY", fy: 2026 });
  });
});

const transcript = [
  `Moderator: The first question is from the line of Priya Shah from ABC Capital.
Priya Shah: Do you expect EBITDA margin of 18% for FY27?
Moderator: Thank you. Next question is from the line of Rahul Mehta.
Rahul Mehta: Can you confirm 20% growth?
Ravi Kumar: Thank you. For FY27, we expect EBITDA margin of 16% to 17% for the company.
Ravi Kumar: Last year we delivered EBITDA margin of 15%, and we expect things to be fine.
Mobile Phones: We expect revenue growth of 30% in FY27.`,
];

describe("transcript reading", () => {
  it("ignores analysts' words", () => {
    const m = managementSpeakers(parseTurns(transcript));
    expect(m.has("Ravi Kumar")).toBe(true);
    expect(m.has("Priya Shah")).toBe(false);
  });
  it("extracts only management's forward statement, with its page", () => {
    const c = extractClaims(transcript, "2026-05-10");
    const margin = c.filter((x) => x.metric === "ebitda_margin");
    expect(margin).toHaveLength(1);
    expect(margin[0]).toMatchObject({ low: 16, high: 17, speaker: "Ravi Kumar", page: 1, period: { kind: "FY", fy: 2027 } });
  });
  it("quotes are verbatim substrings of the document", () => {
    const flat = transcript.join(" ").replace(/\s+/g, " ");
    for (const c of extractClaims(transcript, "2026-05-10")) expect(flat).toContain(c.quote);
  });
  it("flags a product-line heading as narrower scope", () => {
    const c = extractClaims(transcript, "2026-05-10").find((x) => x.metric === "revenue_growth");
    expect(c?.basisNote).toMatch(/heading/);
  });
});

describe("retrieval", () => {
  const chunks = chunkPages("d", [
    "alpha ".repeat(5) + "The company reported strong working capital discipline and receivable days fell materially across the portfolio of businesses this year, supported by better collections and inventory turns in every region where it operates.",
    "beta ".repeat(5) + "Our plant in Gujarat will add capacity and capex of a large amount is planned to support the growth of the cables business across the medium term, subject to demand and approvals from the relevant authorities.",
  ]);
  it("finds the right page", () => expect(search(chunks, "capex capacity plant")[0].page).toBe(2));
  it("abstains when the question's terms are absent", () => {
    const q = "zebra quantum antarctica";
    expect(supported(search(chunks, q)[0], q)).toBe(false);
  });
  it("rejects generated numbers absent from evidence", () => {
    expect(unverifiedNumbers("Margin was 18.5% [1]", "margin of 18.5 percent")).toEqual([]);
    expect(unverifiedNumbers("Margin was 22% [1]", "margin of 18.5 percent")).toEqual(["22"]);
    expect(unverifiedNumbers("Revenue 1,200 [1]", "revenue 1200")).toEqual([]);
  });
});

describe("document discovery", () => {
  it("goes to the file BSE's redirect points at", () => {
    expect(canonicalUrl("https://www.bseindia.com/stockinfo/AnnPdfOpen.aspx?Pname=abc-1.pdf")).toBe("https://www.bseindia.com/xml-data/corpfiling/AttachHis/abc-1.pdf");
    expect(canonicalUrl("https://x.com/a.pdf#page=3")).toBe("https://x.com/a.pdf");
  });
  it("reads transcript links and ignores Screener's own summaries", () => {
    const html = `<div class="documents concalls"><ul><li><div class="nowrap" style="x">Oct 2026</div><a class="button-chip" href="https://x/t.pdf" title="Raw Transcript">Transcript</a><button data-url="/concalls/summary/1/">Notes</button></li></ul></div>`;
    expect(parseDocuments(html)).toEqual([{ kind: "transcript", url: "https://x/t.pdf", label: "Oct 2026" }]);
  });
  it("returns nothing, not an error, on an unrelated page", () => expect(parseDocuments("<html></html>")).toEqual([]));
});
