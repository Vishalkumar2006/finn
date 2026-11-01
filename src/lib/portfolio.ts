/** Tickers verified against Yahoo .NS price data and NSE filings on 2026-11-01. */
export const DEFAULT_PORTFOLIO: { symbol: string; name: string; sector: string }[] = [
  { symbol: "HDFCBANK", name: "HDFC Bank", sector: "Banking" },
  { symbol: "BAJFINANCE", name: "Bajaj Finance", sector: "NBFC" },
  { symbol: "TCS", name: "Tata Consultancy Services", sector: "IT services" },
  { symbol: "PERSISTENT", name: "Persistent Systems", sector: "IT services" },
  { symbol: "RELIANCE", name: "Reliance Industries", sector: "Conglomerate" },
  { symbol: "LT", name: "Larsen & Toubro", sector: "Engineering" },
  { symbol: "BHARTIARTL", name: "Bharti Airtel", sector: "Telecom" },
  { symbol: "MARUTI", name: "Maruti Suzuki", sector: "Autos" },
  { symbol: "SUNPHARMA", name: "Sun Pharma", sector: "Pharma" },
  { symbol: "DIXON", name: "Dixon Technologies", sector: "EMS" },
  { symbol: "TITAN", name: "Titan Company", sector: "Consumer" },
  { symbol: "ASIANPAINT", name: "Asian Paints", sector: "Consumer" },
  { symbol: "POLYCAB", name: "Polycab India", sector: "Cables" },
  { symbol: "ETERNAL", name: "Eternal", sector: "Internet" },
  { symbol: "TRENT", name: "Trent", sector: "Retail" },
  { symbol: "HAL", name: "Hindustan Aeronautics", sector: "Defence" },
  { symbol: "IRCTC", name: "IRCTC", sector: "Travel" },
  { symbol: "CDSL", name: "CDSL", sector: "Market infra" },
  { symbol: "KAYNES", name: "Kaynes Technology", sector: "EMS" },
];

/** Worth trying in Research. The engine has no special cases for them. */
export const RESEARCH_PICKS: { symbol: string; name: string; note: string }[] = [
  { symbol: "SUPREMEIND", name: "Supreme Industries", note: "A margin verdict that depends on how EBITDA is defined" },
  { symbol: "HAL", name: "Hindustan Aeronautics", note: "Guided 7–8% growth, delivered 9.37%" },
  { symbol: "KEI", name: "KEI Industries", note: "Product-line targets FINN declines to score" },
  { symbol: "APLAPOLLO", name: "APL Apollo Tubes", note: "Explicit FY27 EBITDA growth guidance" },
  { symbol: "KPITTECH", name: "KPIT Technologies", note: "Constant-currency guidance" },
  { symbol: "TATAELXSI", name: "Tata Elxsi", note: "Standalone only; few numeric targets" },
];

export const SYMBOL_RE = /^[A-Z0-9&_-]{1,20}$/;
