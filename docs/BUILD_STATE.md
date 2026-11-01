# Build state

Last updated 1 Nov 2026.

## Status

Deployed and public.

- Production: https://finn-delta-eight.vercel.app
- Repository: https://github.com/Vishalkumar2006/finn

The ENAM email has not been sent.

## LLM research layer

Enabled in production and verified against the real provider.

- Primary model: `gemini-3.1-flash-lite`. Fallback: `gemini-3-flash-preview`, tried once on a rate limit, an outage or a timeout. Both go through Gemini's OpenAI-compatible endpoint.
- `gemini-3.8-flash`, the first configured model, was rejected: all three timed test calls ran past 25 seconds, and earlier calls took 184 seconds or returned 503.
- Free-tier limits are low and per model: `gemini-3.6-flash` stopped at 20 requests a day. The limit for the deployed model has not been measured.

How answers are made safe: the model returns claims as JSON. Each claim is checked only against the passages it cites, for numbers, fiscal labels, names, direction of change, verdict words and word overlap. Failing claims are removed and the reader is told. If none survive, or the provider fails, the answer falls back to labelled direct quotes. The model never receives filed figures or guidance verdicts, and its output never reaches them.

Limits: 12 questions a minute per client, 300 model calls a day per server instance (`LLM_DAILY_LIMIT`), 400-character questions, 4 KB bodies, a same-origin check, a 15-second model budget, and a 6-hour cache of checked answers. Counters are in memory and per instance.

| LLM check | Result |
|---|---|
| Unsupported question | Abstains (CEO's pet on L&T, TCS and Supreme) |
| Instructions inside a passage or question | Ignored on the deployed model; invented figure never appeared |
| Outside knowledge, calculation, verdict, share-price forecast | Abstains on all four |
| Bad key, unknown model, timeout | Labelled extractive fallback |
| Fallback model | Fired in production (Bajaj Finance) |
| Claims read against cited passages | L&T, Supreme, Ratnamani, KEI, Century Plyboards, Greenpanel, Titan |
| Limits on the public URL | Long question 400, large body 413, cross-site 403, burst 429 |
| Public outcomes, 8 sampled questions | 4 full, 2 with a claim removed, 1 abstention, 1 failure (below) |

### LLM limitations

- The checks are necessary, not sufficient. They caught wrong numbers and unrelated citations, but an answer can pass and still mislead by framing. One early answer called an old guidance figure current; a prompt rule now requires dated claims, but nothing enforces it.
- The model can't see filed results, so it can't say how guidance turned out. The UI says so and points to Said vs delivered.
- HDFC Bank's first sampled question took 83.6 seconds and returned a non-JSON response. It did not recur (10.4 seconds on the next cold run), and the cause was not established. PDF parsing now yields between pages as a precaution.
- Rate limits are per instance, so a distributed caller can exceed them. The provider quota is the hard ceiling: if it is spent, everyone gets extractive answers until it resets. A billing-enabled key would turn this exposure into cost, so keep a free key or set a budget.

## Production results

Tested against the public URL with headless Chrome at 390px and 1280px, and with direct API calls.

| Check | Result |
|---|---|
| NSE from Vercel | Works: live announcements, XBRL and PDFs all fetched from Vercel |
| Brief, 7 days | 12 material of 80 filings; source PDF link returned 200 |
| Prices and alerts | Trent +5.44% on 3.86× volume, 30 Oct 2026. Lowering the price threshold from 4% to 1% took the inbox from 30 to 69 |
| Financial figures | Tata Elxsi Q2 FY27 revenue 1,055.66 and PAT 170.30 Cr, matching the filed PDF |
| Said vs delivered | L&T shows 15% guided, 11.79% filed, with the correct speaker and an evidence sheet opening the original PDF |
| Unfamiliar tickers, fresh analysis | RATNAMANI, CERA and GRSE, none in the snapshot |
| Cold start | First question on CERA answered in 18.6s, from transcripts and the annual report |
| Follow-up question | Answered with citations on both viewports |
| Invalid ticker | Honest "no NSE price data" and "no results filings"; no invented numbers |
| Security probes | Metadata-URL fetch and path-style symbol both rejected with 400 |
| Layout | No horizontal overflow on any tested page at either width |
| Runtime logs | No error-level entries in the Vercel log queries |

Browser errors were limited to the expected 404s for the invalid ticker, plus one unexplained `ERR_CONNECTION_RESET` on a mobile documents request. It did not recur on desktop or in direct API calls.

### Fallback

NSE was not blocked, so the fallback did not trigger in production. It was tested locally by making NSE, Yahoo and Screener refuse requests, on a production build with an empty cache:

- Brief served labelled snapshot filings with the notice that NSE is unreachable.
- Quotes and L&T research served from the snapshot.
- A ticker outside the snapshot returned an error, and its question abstained. No data was invented.

## Monitoring

There is no unattended monitoring. The scheduled workflow was removed so no bot commits to the repo, because Vercel has no durable disk and a storage service wasn't worth adding. Data is pulled and thresholds checked when a page opens. Snapshots are refreshed by hand: `npm run ingest`, commit, deploy. Research uses the saved analysis for 48 hours after a refresh, then runs live.

## Other checks

| Check | Result |
|---|---|
| Unit tests, lint, typecheck, build | 125 tests pass; others clean |
| Commit identity | All commits `Vishalkumar2006 <vishku2004@gmail.com>`, no AI trailers |
| Secrets in Git history | Pattern scan found none; no env files, logs or PDFs tracked |

## Not verified

- A physical phone. Mobile results are Chrome device emulation.
- The Vercel request-log status query returned no usable data, so the log result above covers error-level entries only.
- The cause of the first production question timeout was not confirmed. Slow cold-start parsing is the likely cause; it did not recur after the fix.
- NSE access may vary over time. Today's success does not guarantee it stays open.

## Accuracy findings from manual review

Reading scored claims in context found false verdicts that are now fixed, each with a regression test:

- KEI: a product-line rupee target scored against company revenue.
- IRCTC: a reported past figure scored as guidance.
- Bajaj Finance: AUM growth scored as revenue growth.
- Sona: a revenue share scored as growth.
- Supreme: "missed" held only on one EBITDA definition.
- L&T: "10% and 15% respectively" read as 10% revenue growth, a P&M business margin treated as company-wide, and a page footer taken as the speaker.
- Ratnamani (found in production): past-tense commentary scored as guidance.

Each scored claim in the snapshot was read in context, but rules can still misfire on companies not reviewed. Ratnamani shows that new tickers do surface new error types.

## Remaining before submission

1. Open the app on a real phone.
2. Review the AI build history and attach it. Copy kept outside the repo in `C:\Users\vishk\Projects\finn-ai-build-history`.
