# Build state

Last updated 1 Nov 2026.

## Status

Deployed and public.

- Production: https://finn-delta-eight.vercel.app
- Repository: https://github.com/Vishalkumar2006/finn

The ENAM email has not been sent.

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
| Unit tests, lint, typecheck, build | 91 tests pass; others clean |
| Commit identity | All commits `Vishalkumar2006 <vishku2004@gmail.com>`, no AI trailers |
| Secrets in Git history | Pattern scan found none; no env files, logs or PDFs tracked |

## Not verified

- A physical phone. Mobile results are Chrome device emulation.
- The LLM path has never called a real provider. Only its number validator is tested.
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
2. Decide on the optional LLM layer.
3. Review the AI build history and attach it. Copy kept outside the repo in `C:\Users\vishk\Projects\finn-ai-build-history`.
4. Fill the name and build-history placeholders in `docs/SUBMISSION.md`, then send it.
