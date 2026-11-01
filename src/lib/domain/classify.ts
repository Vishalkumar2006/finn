import type { BriefItem, Category, Priority, RawAnnouncement } from "./types";

const RULES: [Category, RegExp][] = [
  ["pledging", /\bpledg|encumbr/i],
  ["insider_trading", /insider trading|\bsast\b|reg(ulation)?\.? ?7\(2\)|substantial acquisition/i],
  ["credit_rating", /credit rating|\brating(s)? (assigned|reaffirmed|upgrade|downgrade)|\bcrisil\b|\bicra\b|\bcare ratings\b|india ratings/i],
  ["bonus_split", /\bbonus (issue|shares|equity)|sub-?division|stock split|split of/i],
  ["fund_raise", /\bqip\b|qualified institution|rights issue|preferential (issue|allot)|buy-?back|commercial paper|non-?convertible debenture|\bncds?\b|fund rais|raising of funds|allotment of (equity|securities|debentures)|monitoring agency/i],
  ["M&A", /acqui(sition|re)|merger|amalgamation|demerger|joint venture|scheme of arrangement|disinvest|sale of (stake|subsidiary|business)|incorporation of .*subsidiary|investment in .*subsidiary/i],
  ["litigation", /litigation|dispute|tax (demand|order|penalty)|penalt|action\(s\) (taken|initiated)|orders? passed|insolvency|nclt|show cause|regulatory (order|action)/i],
  ["management_change", /change in (management|director)|resignation|appointment|cessation|re-?appoint|managing director|chief (executive|financial|operating)|\bceo\b|\bcfo\b|key managerial|senior management/i],
  ["earnings_call", /transcript|earnings call|con\.? ?call|conference call|audio recording|video recording/i],
  ["investor_meetings", /analyst(s)?\b|investor meet|institutional investor|investor conference/i],
  ["dividend", /dividend/i],
  ["postal_ballot", /postal ballot/i],
  ["agm_egm", /annual general meeting|\bagm\b|\begm\b|extra-?ordinary general|shareholders meeting/i],
  ["capex", /capex|capital expenditure|capacity expansion|new (plant|facility|factory)|commissioning|greenfield|brownfield/i],
  ["results", /financial results?|integrated filing- ?financial|results? for the (quarter|period|year)|quarterly results|unaudited .*results|audited .*results/i],
  ["press_release", /press release|order (win|received|bagged)|awarded|new product|partnership|clarification|investor presentation|bagging|receiving of orders/i],
];

/** Low-signal paperwork, checked first so a word like "dividend" in a newspaper ad does not promote it. */
const ROUTINE = /newspaper|certificate under|esop|esos|esps|trading window|compliance certificate|loss of share|duplicate share|record date|statement of deviation|investor complaints|\besg\b|brsr|business responsibility|closure of trading/i;

const WHY: Record<Category, string> = {
  results: "Primary read on the business; compare with the prior quarter and year.",
  "M&A": "Changes the shape of the business or its capital allocation.",
  fund_raise: "Fresh capital can dilute holders and signals funding needs.",
  management_change: "A leadership change can reset strategy and execution.",
  litigation: "Potential financial or regulatory liability; check the size.",
  insider_trading: "Insiders are transacting in their own shares.",
  earnings_call: "Management commentary and guidance live here.",
  investor_meetings: "Scheduling notice; rarely new information.",
  credit_rating: "An outside view of balance-sheet risk.",
  dividend: "Cash return to shareholders.",
  bonus_split: "Share count changes; no change in economic value.",
  capex: "A capital commitment that shapes future capacity.",
  press_release: "Company-framed news; check for substance.",
  postal_ballot: "Shareholder vote; usually procedural.",
  agm_egm: "Shareholder meeting; usually procedural.",
  pledging: "Promoter pledges are a governance and overhang risk.",
  unclassified: "Routine compliance paperwork.",
};

const PRIORITY: Record<Category, Priority> = {
  results: "critical", "M&A": "critical", management_change: "critical", litigation: "critical", pledging: "critical",
  fund_raise: "notable", credit_rating: "notable", capex: "notable", bonus_split: "notable", dividend: "notable",
  insider_trading: "notable", earnings_call: "notable", press_release: "notable",
  investor_meetings: "routine", postal_ballot: "routine", agm_egm: "routine", unclassified: "routine",
};

export function classify(desc: string, text: string): Category {
  const all = `${desc} ${text}`;
  if (ROUTINE.test(desc)) return "unclassified";
  // The exchange's own subject is the most reliable signal; body text only breaks ties on generic subjects.
  for (const [cat, re] of RULES) if (re.test(desc)) return refine(cat, all);
  if (/^(outcome of board meeting|board meeting|updates?|general updates?)/i.test(desc) || !desc) {
    if (ROUTINE.test(text)) return "unclassified";
    for (const [cat, re] of RULES) if (re.test(text)) return refine(cat, all);
  }
  return "unclassified";
}

function refine(cat: Category, all: string): Category {
  if (cat === "investor_meetings" && /transcript|earnings call|audio recording|video recording/i.test(all)) return "earnings_call";
  return cat;
}

function priorityOf(cat: Category, all: string): Priority {
  if (cat === "management_change") {
    // Top-seat changes outrank routine senior-management movement.
    return /\b(ceo|cfo|chief executive|chief financial|managing director|md|chairman|whole-?time director)\b/i.test(all) ? "critical" : "notable";
  }
  if (cat === "results" && /prior intimation|to consider/i.test(all)) return "notable";
  return PRIORITY[cat];
}

/** Strip the exchange's boilerplate so the line says something. Never adds words of its own. */
export function summarise(a: Pick<RawAnnouncement, "company" | "text" | "desc">): string {
  let s = (a.text || "").replace(/\s+/g, " ").trim();
  s = s.replace(/^.{0,80}?has (informed|submitted to|intimated)( to)?( the)? exchange,?( about| regarding| that)?\s*/i, "");
  if (!s) return a.desc;
  s = s[0].toUpperCase() + s.slice(1);
  return s.length > 180 ? `${s.slice(0, 177).replace(/\s+\S*$/, "")}…` : s;
}

const RANK: Record<Priority, number> = { critical: 0, notable: 1, routine: 2 };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Classify, cluster and rank. Same company + category within 48h collapses into one item with the others kept
 * under `related`, so nothing is dropped. A results filing also absorbs its deck and press release.
 */
export function buildBrief(raw: RawAnnouncement[]): BriefItem[] {
  const seen = new Set<string>();
  const items: BriefItem[] = [];
  const sorted = [...raw].sort((x, y) => Date.parse(y.at) - Date.parse(x.at));
  for (const a of sorted) {
    if (seen.has(a.seqId)) continue;
    seen.add(a.seqId);
    const category = classify(a.desc, a.text);
    const priority = priorityOf(category, `${a.desc} ${a.text}`);
    const absorbedByResults = (i: BriefItem, cat: Category, desc: string) =>
      (i.category === "results" && /investor presentation|press release/i.test(desc)) ||
      (cat === "results" && /investor presentation|press release/i.test(i.desc));
    const peer = items.find(
      (i) => i.symbol === a.symbol && Math.abs(Date.parse(i.at) - Date.parse(a.at)) <= 48 * 3600e3 &&
        (i.category === category || absorbedByResults(i, category, a.desc) || (a.text && norm(i.text) === norm(a.text))),
    );
    if (peer) {
      peer.related.push({ desc: a.desc, at: a.at, url: a.url, seqId: a.seqId });
      if (RANK[priority] < RANK[peer.priority]) {
        peer.priority = priority;
        peer.category = category;
        peer.why = WHY[category];
      }
      continue;
    }
    items.push({ ...a, category, priority, why: WHY[category], summary: summarise(a), related: [] });
  }
  return items.sort((x, y) => RANK[x.priority] - RANK[y.priority] || Date.parse(y.at) - Date.parse(x.at));
}
