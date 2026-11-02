# FINN

A mobile-first investment agent for Indian listed companies. It tells you what changed across your portfolio, why it matters, and what the primary evidence actually says.

- **Brief**: filings across your holdings, ranked. Material items first, routine ones collapsed but kept. Results show Revenue, EBITDA, PBT and PAT with QoQ and YoY. Appointments show the profile from the filing.
- **Alerts**: your price and volume thresholds, checked deterministically on end-of-day data, plus the filing types you choose.
- **Research**: any NSE ticker. The core is **Said vs delivered**: management's statements from transcripts, tested against filed numbers. Every claim opens its source.

## Run it

```bash
npm ci
npm run dev        # http://localhost:3000
npm test           # unit tests
npm run build      # production build
npm run ingest     # refresh data/snapshot from live sources
```

Node 22+. No keys needed. To let a model synthesize answers, set the variables in `.env.example` (verified with `gemini-3.1-flash-lite` on Gemini's OpenAI-compatible endpoint); without them, answers are direct quotes and the UI says so.

## Data sources

| Data | Source | Used for |
|---|---|---|
| End-of-day price and volume | Yahoo Finance chart API (`.NS`) | Watchlist, signals |
| Announcements | NSE corporate announcements | Brief, alerts |
| Quarterly and annual numbers | NSE XBRL results filings (legacy and integrated feeds) | All financial figures |
| Transcripts, annual reports | NSE filings; Screener only to locate company PDFs on BSE or company sites | Research, Q&A |

Screener's ratios and summaries are never read. BSE's announcement API refused automated access, so it is not used, and no source is accessed with a disguised client.

## How it works

```
src/lib/sources    fetching and parsing: replaceable, no analysis
src/lib/domain     pure logic: metrics, classification, guidance, retrieval. Fully unit tested
src/lib/research   the pipeline: resolve → find documents → extract → validate → compute → cite
src/lib/feed.ts    live data with cache and snapshot fallback; every payload carries its provenance
src/app            mobile-first UI and API routes
scripts/ingest.ts  manual snapshot refresh
```

**Numbers are never produced by a model.** They come from XBRL tags and are computed in `domain/metrics.ts`. Periods are matched by date, so a YoY can't use the wrong quarter, and mixing bases or period types throws.

**A verdict must survive every definition.** A statement is scored only if it names a number, a period and a metric that filings can test, covers the whole company, and comes from management. The result must then hold on both consolidated and standalone numbers, and for EBITDA margin, with and without other income. Otherwise FINN shows the range or declines to score.

**Retrieved text is data.** The optional model has no tools and cannot set a filed number or verdict. On ordinary questions it never receives them. On guidance questions it may read them as evidence beside a verdict already computed by `domain/guidance.ts`, and an explanation that states its own verdict is thrown away whole (`domain/outcome.ts`). It sees passages inside delimiters with an instruction to ignore anything in them. Each claim it returns is checked against the passages it cites (`domain/answerCheck.ts`). Claims that fail are removed and counted on screen, and if none survive the answer falls back to labelled direct quotes.

**Efficient by default.** One market-wide filings call serves any portfolio. Parsed filings are cached and shared between server instances. Search is BM25 over page chunks, with no vector database. The product costs nothing to run without a model.

## Limitations

- Background monitoring runs once a day on the shared demo portfolio at fixed thresholds, and stores its findings for the Alerts page. There are no push notifications. Your own portfolio and thresholds stay on your device and are checked when a page is opened. Snapshots are refreshed by hand with `npm run ingest`.
- Alerts appear in the app only, and rules and read state stay on one device. There are no phone or email notifications.
- Guidance extraction is rule-based and conservative, so most statements end up as "can't test". Few verdicts are given, and those are favoured to be right.
- Scanned PDFs have no OCR. Some companies file only a link notice instead of a transcript; these are listed as skipped.
- EBITDA is derived from filed lines and excludes other income, so it can differ from a company's own figure.
- Older filings often lack cash flow and balance sheet data; these show as a dash.
- Annual reports are searched up to page 160 and transcripts up to page 60. The UI states the coverage of each search.
- LinkedIn is not scraped because it is login-walled. Profiles come from the filing itself.

See [docs/BUILD_STATE.md](docs/BUILD_STATE.md) for what has been verified.
