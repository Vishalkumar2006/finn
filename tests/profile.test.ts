import { describe, expect, it } from "vitest";
import { extractProfile } from "@/lib/domain/profile";
import { parseChart } from "@/lib/sources/yahoo";
import { nseDate } from "@/lib/sources/nse";

describe("filed profile", () => {
  it("returns career text verbatim with its page", () => {
    const pages = ["Cover letter", "Brief profile\nShe has 20 years of experience in finance and previously served as CFO at a listed company in the sector."];
    expect(extractProfile(pages)).toMatchObject({ page: 2 });
    expect(extractProfile(pages)?.text).toContain("20 years of experience");
  });
  it("rejects legal boilerplate", () => {
    expect(extractProfile(["The statement has been prepared in accordance with Ind AS 34 by the Company and joined with other material for this period of review here."])).toBeNull();
  });
  it("returns null rather than guessing", () => expect(extractProfile(["Nothing relevant on this page."])).toBeNull());
});

describe("EOD parsing", () => {
  const ts = (d: string) => Date.parse(`${d}T09:15:00+05:30`) / 1000;
  const chart = (rows: [string, number | null, number | null][]) => ({
    chart: { result: [{ meta: { currency: "INR" }, timestamp: rows.map((r) => ts(r[0])), indicators: { quote: [{ close: rows.map((r) => r[1]), volume: rows.map((r) => r[2]) }] } }] },
  });
  it("drops missing values instead of zero-filling", () => {
    const h = parseChart(chart([["2026-10-29", 100, 5], ["2026-10-30", null, 6]]), "X", new Date("2026-11-01T06:00:00Z"));
    expect(h.bars).toEqual([{ date: "2026-10-29", close: 100, volume: 5 }]);
  });
  it("never treats an open session as end of day", () => {
    const rows: [string, number, number][] = [["2026-10-29", 100, 5], ["2026-10-30", 101, 6]];
    expect(parseChart(chart(rows), "X", new Date("2026-10-30T06:00:00Z")).bars).toHaveLength(1); // 11:30 IST
    expect(parseChart(chart(rows), "X", new Date("2026-10-30T11:00:00Z")).bars).toHaveLength(2); // 16:30 IST
  });
  it("errors on an unknown ticker", () => {
    expect(() => parseChart({ chart: { result: null } }, "X")).toThrow();
  });
});

describe("NSE dates", () => {
  it("keeps IST explicit", () => expect(nseDate("31-Oct-2026 17:34:03")).toBe("2026-10-31T17:34:03+05:30"));
  it("handles the upper-case date form", () => expect(nseDate("30-SEP-2026")).toBe("2026-09-30T00:00:00+05:30"));
  it("returns null on junk", () => expect(nseDate("n/a")).toBeNull());
});
