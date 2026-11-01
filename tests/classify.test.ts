import { describe, expect, it } from "vitest";
import { buildBrief, classify, summarise } from "@/lib/domain/classify";
import type { RawAnnouncement } from "@/lib/domain/types";

const a = (seqId: string, desc: string, text = "", at = "2026-10-31T10:00:00+05:30", symbol = "ABC"): RawAnnouncement =>
  ({ seqId, desc, text, at, symbol, company: "Abc Limited", url: `https://x/${seqId}.pdf` });

describe("classify", () => {
  it.each([
    ["Integrated Filing- Financial", "", "results"],
    ["Outcome of Board Meeting", "submitted the financial results for the period ended", "results"],
    ["Acquisition", "", "M&A"],
    ["Resignation of Director/KMP/SMP", "", "management_change"],
    ["Pendency of Litigation(s)/dispute(s) or the outcome impacting the Company", "", "litigation"],
    ["Analysts/Institutional Investor Meet/Con. Call Updates", "has informed the Exchange about Transcript", "earnings_call"],
    ["Copy of Newspaper Publication", "financial results dividend", "unclassified"],
    ["ESOP/ESOS/ESPS", "", "unclassified"],
    ["Dividend", "", "dividend"],
    ["Shareholders meeting", "", "agm_egm"],
    ["Press Release", "", "press_release"],
  ])("%s", (desc, text, want) => expect(classify(desc, text)).toBe(want));
  it("marks an unknown subject unclassified rather than guessing", () => {
    expect(classify("Something new", "")).toBe("unclassified");
  });
});

describe("brief", () => {
  it("ranks material before routine", () => {
    const b = buildBrief([a("1", "ESOP/ESOS/ESPS"), a("2", "Acquisition", "", "2026-10-30T10:00:00+05:30")]);
    expect(b.map((i) => i.priority)).toEqual(["critical", "routine"]);
  });
  it("keeps routine items instead of deleting them", () => {
    expect(buildBrief([a("1", "Copy of Newspaper Publication")])).toHaveLength(1);
  });
  it("collapses related filings but retains them", () => {
    const b = buildBrief([a("1", "Integrated Filing- Financial"), a("2", "Investor Presentation", "", "2026-10-31T11:00:00+05:30"), a("3", "Outcome of Board Meeting", "financial results for the quarter", "2026-10-31T09:00:00+05:30")]);
    expect(b).toHaveLength(1);
    expect(b[0].related).toHaveLength(2);
    expect(b[0].category).toBe("results");
  });
  it("drops exact duplicates by id", () => {
    expect(buildBrief([a("1", "Dividend"), a("1", "Dividend")])).toHaveLength(1);
  });
  it("does not cluster across companies or beyond 48h", () => {
    expect(buildBrief([a("1", "Dividend"), a("2", "Dividend", "", undefined, "XYZ")])).toHaveLength(2);
    expect(buildBrief([a("1", "Dividend"), a("2", "Dividend", "", "2026-10-20T10:00:00+05:30")])).toHaveLength(2);
  });
  it("separates a CFO exit from other management movement", () => {
    expect(buildBrief([a("1", "Resignation", "resignation of Chief Financial Officer")])[0].priority).toBe("critical");
    expect(buildBrief([a("1", "Change in Management", "senior manager resigned")])[0].priority).toBe("notable");
  });
  it("strips boilerplate without inventing words", () => {
    expect(summarise({ company: "Abc Limited", desc: "d", text: "Abc Limited has informed the Exchange about Transcript" })).toBe("Transcript");
    expect(summarise({ company: "Abc Limited", desc: "Dividend", text: "" })).toBe("Dividend");
  });
});
