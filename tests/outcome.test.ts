import { describe as group, expect, it } from "vitest";
import { evaluateRobust, extractClaims } from "@/lib/domain/guidance";
import { fiscalLabel } from "@/lib/domain/metrics";
import { buildOutcome, checkExplanation, outcomeIntent, type OutcomeItem, type OutcomeRow } from "@/lib/domain/outcome";
import type { PeriodFacts } from "@/lib/domain/types";

const TODAY = "2026-11-02";
const LATEST = "2026-09-30";

const facts = (end: string, revenue: number, ebitda: number | null, otherIncome = 0): PeriodFacts => ({
  kind: "FY", label: fiscalLabel(end, "FY"), periodStart: "", periodEnd: end, basis: "consolidated", entityClass: "operating",
  revenue, revenueLabel: "Revenue from operations", otherIncome, financeCosts: null, depreciation: null, totalExpenses: null,
  pbt: null, pat: 50, ebitda, ebit: null, nii: null, ppop: null, cfo: null, capex: null, borrowings: null, equity: null,
  audited: null, source: { url: `https://nsearchives.nseindia.com/${end}.xml`, title: `XBRL ${end}`, docType: "xbrl_results", period: fiscalLabel(end, "FY") },
});

/** Rows made by the real extraction and evaluation, from the wording of real transcripts. */
function rows(lines: string[], callDate: string, label: string, series: PeriodFacts[], other: PeriodFacts[] | null = null): OutcomeRow[] {
  return extractClaims([lines.map((l) => `Ravi Kumar: ${l}`).join("\n")], callDate).map((claim) => ({
    claim, evaluation: evaluateRobust(claim, series, other, LATEST), callLabel: label,
    source: { url: `https://nsearchives.nseindia.com/${callDate}.pdf`, title: `Earnings call transcript, ${label}`, docType: "transcript", page: claim.page, excerpt: claim.quote, filedAt: callDate },
  }));
}
const ask = (q: string) => outcomeIntent(q, TODAY)!;

// L&T's filed FY26 growth was 11.79%. These round figures give the same result.
const lt = [facts("2026-03-31", 111.79, 12), facts("2025-03-31", 100, 11)];
const ltRows = [
  ...rows(["Accordingly, we maintain our full year FY26 revenue growth guidance at 15%."], "2025-11-10", "Nov 2025", lt),
  ...rows(["We are reasonably confident of achieving our full year FY26 revenue growth guidance of 15%."], "2026-02-10", "Feb 2026", lt),
  ...rows(["We expect our group order inflows and group revenues to grow at 10% and 15% respectively for FY26."], "2025-08-10", "Aug 2025", lt),
  ...rows(["For now, we remain committed to our FY27 growth guidance of 10% to 12% revenue growth."], "2026-08-10", "Aug 2026", lt),
];

group("which questions get a comparison", () => {
  it.each([
    "Did L&T management deliver on its FY26 revenue growth guidance?",
    "Did management meet its revenue guidance?",
    "What did management promise for FY26, and what happened?",
    "Has the company delivered on its margin expectations?",
    "Compare management's guidance against reported results.",
    "What evidence suggests management's expectations were realistic?",
  ])("%s", (q) => expect(outcomeIntent(q, TODAY)).not.toBeNull());

  it.each([
    "What is management saying about margins?",
    "What are the main risks?",
    "What is the capex plan?",
    "What is the FY27 revenue guidance?",
    "Do they own a pet food business?",
    "Did the company meet its net zero target?",
    "Did they hit the hiring target?",
  ])("not: %s", (q) => expect(outcomeIntent(q, TODAY)).toBeNull());
});

group("L&T: group revenue guidance against the filing", () => {
  const o = buildOutcome(ltRows, "consolidated", ask("Did L&T management deliver on its FY26 revenue growth guidance?"));
  it("gives the filed figure and the rule's verdict", () => {
    expect(o.items).toHaveLength(1);
    const e = o.items[0].row.evaluation;
    expect(e.status).toBe("missed");
    expect(e.actual?.value).toBe(11.79);
    expect(e.variance).toBe(-3.21);
    expect(o.summary[0]).toContain("15% revenue growth for FY26");
    expect(o.summary[0]).toContain("11.79%, 3.21 points below it: missed");
  });
  it("treats one target repeated on two calls as one, from the latest", () => {
    expect(o.items[0].row.callLabel).toBe("Feb 2026");
    expect(o.items[0].alsoSaid.map((a) => a.callLabel)).toEqual(["Nov 2025"]);
  });
  it("keeps transcript and filing sources separate, with the comparison period's own", () => {
    const r = o.items[0].row;
    expect(r.source.docType).toBe("transcript");
    expect(r.source.url).toContain("2026-02-10.pdf");
    expect(r.evaluation.actual?.source.url).toContain("2026-03-31.xml");
    expect(r.evaluation.actual?.compareSource?.url).toContain("2025-03-31.xml");
  });
  it("does not pick a number from a respectively sentence", () => {
    const n = o.notTested.find((r) => /respectively/.test(r.claim.quote));
    expect(n?.evaluation.status).toBe("insufficient");
    expect(n?.evaluation.actual).toBeNull();
  });
  it("does not mix in a different year", () => {
    expect(o.items.every((i) => i.row.claim.period?.fy === 2026)).toBe(true);
  });
});

group("a target not yet due", () => {
  it("has no verdict and no filed figure", () => {
    const o = buildOutcome(ltRows, "consolidated", ask("Did L&T meet its FY27 revenue guidance?"));
    expect(o.items[0].row.evaluation.status).toBe("not_yet");
    expect(o.items[0].row.evaluation.actual).toBeNull();
    expect(o.summary[0]).toMatch(/not been reported yet, so there is no verdict/);
    expect(o.summary[0]).not.toMatch(/missed|met\b|exceeded/);
  });
});

group("Supreme: EBITDA margin that depends on the definition", () => {
  const primary = [facts("2026-03-31", 1000, 138.5, 9.2), facts("2025-03-31", 800, 100)];
  const r = rows(["We told them because our EBITDA margin for the full year FY26 will be between 14.5% to 15%."], "2025-10-20", "Oct 2025", primary);
  const o = buildOutcome(r, "consolidated", ask("Did Supreme meet its EBITDA margin guidance?"));
  it("shows the range and gives no verdict", () => {
    const e = o.items[0].row.evaluation;
    expect(e.status).toBe("insufficient");
    expect(e.range).toEqual({ low: 13.85, high: 14.77, basisTested: "the filed basis" });
    expect(o.summary[0]).toMatch(/13.85% to 14.77%.*no verdict/);
    expect(o.summary[0]).not.toMatch(/: missed|: met|: exceeded/);
  });
});

group("Bajaj Finance: AUM is not revenue", () => {
  const series = [facts("2026-03-31", 2000, null), facts("2025-03-31", 1000, null)];
  const r = rows(["We expect the top line growth or AUM growth will gravitate between 22% and 23% on a full year FY26 basis."], "2025-10-20", "Oct 2025", series);
  it("is never scored as revenue", () => {
    expect(r[0].claim.metric).toBe("other");
    const o = buildOutcome(r, "consolidated", ask("Did Bajaj Finance meet its FY26 revenue guidance?"));
    expect(o.items).toEqual([]);
    expect(o.notTested[0].evaluation.actual).toBeNull();
  });
  it("gets no verdict when AUM is what was asked", () => {
    const o = buildOutcome(r, "consolidated", ask("Did Bajaj Finance deliver on its FY26 AUM growth guidance?"));
    expect(o.items).toEqual([]);
    expect(o.summary[0]).toMatch(/none can be compared/);
  });
});

group("KEI: product-line targets", () => {
  const series = [facts("2026-03-31", 11747.765, null), facts("2025-03-31", 9000, null)];
  it("does not score a product line as the company", () => {
    const line = rows(["Sir, on a full year FY26 basis, we will achieve the top line of close to Rs.550 crores to Rs.600 crores."], "2025-07-20", "Jul 2025", [{ ...series[0], revenue: 117477650000 }, series[1]]);
    const seg = rows(["We expect the Cables segment revenue growth of 30% in FY26."], "2025-07-20", "Jul 2025", series);
    const o = buildOutcome([...line, ...seg], "consolidated", ask("Did KEI meet its FY26 revenue guidance?"));
    expect(o.items).toEqual([]);
    expect(o.notTested.every((r) => r.evaluation.actual === null)).toBe(true);
  });
  // Real statement: Sanand is one plant, and an unreported period gets no scale check, so it could read as company revenue.
  it("does not present a future plant-level rupee target as company guidance", () => {
    const r = rows(["We expect around INR1,500 crores to INR2,000 crores revenue from Sanand in this financial year, which will come in the contribution in this particular -- in FY27."], "2026-08-20", "Aug 2026", lt);
    expect(r[0].evaluation.status).toBe("not_yet");
    const o = buildOutcome(r, "consolidated", ask("Did KEI deliver on its FY27 revenue guidance?"));
    expect(o.items).toEqual([]);
    expect(o.notTested).toHaveLength(1);
  });
});

group("past results are not guidance", () => {
  it("IRCTC: reported numbers in a transcript give no statement to score", () => {
    const r = rows(["Revenue growth in FY25 was 9% and we delivered that in full."], "2026-05-20", "May 2026", lt);
    expect(r).toEqual([]);
    expect(buildOutcome(r, "consolidated", ask("Did IRCTC meet its revenue guidance?")).summary[0]).toMatch(/no management statement/);
  });
  it("Ratnamani: past-tense commentary gives no statement to score", () => {
    expect(rows(["Going forward this year, with no such revenue growth, margins were just above the double-digit figure."], "2026-05-20", "May 2026", lt)).toEqual([]);
  });
});

group("missing sources", () => {
  it("no usable transcript gives no comparison, and says so", () => {
    const o = buildOutcome([], "consolidated", ask("Did the company meet its FY26 revenue guidance?"));
    expect(o.items).toEqual([]);
    expect(o.summary[0]).toMatch(/no management statement on revenue for FY26/);
  });
  it("incomplete XBRL gives no verdict: the comparison year or period is absent", () => {
    const noBase = rows(["We expect FY26 revenue growth of 15% for the company."], "2025-10-20", "Oct 2025", [facts("2026-03-31", 110, null)]);
    const noYear = rows(["We expect FY26 revenue growth of 15% for the company."], "2025-10-20", "Oct 2025", []);
    for (const r of [noBase, noYear]) {
      const o = buildOutcome(r, "consolidated", ask("Did they deliver on FY26 revenue guidance?"));
      expect(o.items).toEqual([]);
      expect(o.notTested[0].evaluation.status).toBe("insufficient");
    }
  });
});

group("basis", () => {
  it("won't score a standalone statement on a consolidated filing, even if the numbers agree", () => {
    const r = rows(["We expect standalone FY26 revenue growth of 11% to 12%."], "2025-10-20", "Oct 2025", lt);
    const o = buildOutcome(r, "consolidated", ask("Did they meet FY26 revenue guidance?"));
    expect(o.items).toEqual([]);
    expect(o.notTested[0].evaluation.reason).toMatch(/standalone basis/);
  });
});

group("the model's explanation", () => {
  const o = buildOutcome(ltRows, "consolidated", ask("Did L&T management deliver on its FY26 revenue growth guidance?"));
  const items = o.items as OutcomeItem[];
  const passages = ["Verified result, FY26. Management guided 15% revenue growth. The filing shows 11.79%: missed.", "Earnings call transcript, Feb 2026. On the Feb 2026 call management expected a customary ramp-up in project execution during Q4 and said it was reasonably confident."];
  const say = (text: string, citations = [2]) => ({ status: "answered" as const, claims: [{ text, citations }] });

  it("accepts context that stays with its source", () => {
    const r = checkExplanation(say("On the Feb 2026 call, management expected a customary ramp-up in project execution during Q4."), passages, items);
    expect(r.ok).toBe(true);
  });
  it.each([
    "On the Feb 2026 call, management missed its project execution ramp-up.",
    "Management delivered the customary ramp-up in project execution.",
    "On the Feb 2026 call, management exceeded expectations on project execution.",
  ])("refuses a verdict of its own: %s", (text) => {
    expect(checkExplanation(say(text), passages, items)).toEqual({ ok: false, reason: "it stated a verdict of its own" });
  });
  it("refuses even the correct verdict, because the card already decides it", () => {
    expect(checkExplanation(say("Revenue growth of 11.79% missed the guidance.", [1]), passages, items).ok).toBe(false);
  });
  it("refuses a reported figure that contradicts the filing", () => {
    expect(checkExplanation(say("Revenue grew 15% in FY26.", [1]), passages, items)).toEqual({ ok: false, reason: "it contradicted a filed figure" });
  });
  it("refuses a number of its own", () => {
    expect(checkExplanation(say("Management expected execution ramp-up worth 3.21 points.", [2]), passages, items).ok).toBe(false);
  });
  it("refuses investment advice", () => {
    expect(checkExplanation(say("Investors should buy on the project execution ramp-up."), passages, items)).toEqual({ ok: false, reason: "it gave investment advice" });
  });
  it("uses no explanation at all if the model abstains", () => {
    expect(checkExplanation({ status: "abstain", claims: [], reason: "nothing" }, passages, items).ok).toBe(false);
  });
});
