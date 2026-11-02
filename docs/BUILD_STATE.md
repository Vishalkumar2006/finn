# Build state

Last updated 2 Nov 2026.

## Status

Deployed and public.

- Production: https://finn-delta-eight.vercel.app
- Repository: https://github.com/Vishalkumar2006/finn

The ENAM email has not been sent.

## Research performance

Functions moved from iad1 (US East) to bom1 (Mumbai) on 2 Nov 2026. Measured on the public URL, one question at a time, at each release's first questions after deployment.

| Scenario | Before (iad1) | After (bom1) | Samples, before / after |
|---|---|---|---|
| First question, same four tickers (L&T, KEI, CERA, Polycab), API | median 22.9s, slowest 46.7s | median 8.9s, slowest 13.9s | 4 / 4 |
| First question, five tickers including Siemens, API | not measured | median 10.4s, slowest 13.9s | 0 / 5 |
| Page opened, question 12s later, API | not measured | median 4.5s, slowest 11.4s | 0 / 5 |
| Identical question already answered | not reached across instances: 11.7s to 44s on the first release with this comparison | 0.4s to 0.6s | 5 / 8 |
| First question through the real page (headless Chrome, 390px and 1280px) | not measured | 6.0s, 9.2s, 17.4s, 20.5s | 0 / 4 |

The "before" repeat figures come from commit b8360bc, which had the old per-instance cache. Same-instance second questions were already about 3s.

Where the time went, cold, before: documents 6 to 41s (nearly all download; one large report blocked the rest), model 2.6 to 11.6s, discovery 1.3 to 1.7s, parsing 0.7 to 1.9s, chunking and BM25 under 40ms. The stage split comes from a local production build; deployments now send a `Server-Timing` header.

What changed:

- **Region:** `vercel.json` sets bom1. This alone took the five-ticker cold median from 14.1s to 10.4s.
- **Bounded document wait:** once a transcript is readable, a question waits at most 8s for the other documents. Anything later is named on the answer ("Still loading, so not used here") and in "What was searched". With no readable transcript, the 40s budget still applies.
- **Reading starts on page open:** `?part=warm` returns at once and reads documents in the background. Limited to 12 a minute per client.
- **Shared cache:** Vercel Runtime Cache sits behind memory and `/tmp`, so instances reuse each other's work. Only entries with TTLs of at least an hour use it.
- **Oversized PDFs:** refused from `content-length`. Havells' 55 MB report used to be downloaded (33s) and rejected on every question.

Cache rules:

- TTLs are unchanged: parsed PDFs 30 days, document lists 12 hours, checked answers 6 hours.
- Shared entries are stored for twice their TTL. Past the TTL they are refetched, and served only if the source is down, marked stale as before.
- Shared keys include the deployment id, so each deployment starts empty and a parser fix can't read old output. Answer keys also include the prompt version, model and passages.
- The store can evict entries or be paused. Either only costs a download.

Costs:

- Model calls: page-open reading makes none. A repeated question makes none unless its passages changed. A question first answered without the annual report can cost one more call once the report arrives (Polycab, Siemens and L&T did in the benchmark).
- Runtime Cache: free on Hobby up to 1M read and 200K write units a month, then paused rather than charged, per Vercel's docs. The team's plan and the usage so far could not be read from the CLI; check the Observability tab. On a paid plan it is billed at low per-unit rates.

### Performance limitations

- A first answer can omit the annual report. In the cold benchmark this happened on three of five tickers. The answer says so, and asking again includes it.
- The real page is slower than the API because its other requests load at the same time. Two of four cold page samples took over 17s.
- Model latency varies: the same model took 0.6 to 11s, and the fallback model is slower.
- Annual reports over 40 MB are not read, as before. They are now reported quickly as over the limit.
- Timings were not re-measured on a physical phone.
- Each sample is one run, on a small sample. A new deployment starts with an empty cache.

## LLM research layer

Enabled in production and verified against the real provider.

- Primary model: `gemini-3.1-flash-lite`. Fallback: `gemini-3-flash-preview`, tried once on a rate limit, an outage or a timeout. Both go through Gemini's OpenAI-compatible endpoint.
- `gemini-3.8-flash`, the first configured model, was rejected: all three timed test calls ran past 25 seconds, and earlier calls took 184 seconds or returned 503.
- Free-tier limits are low and per model: `gemini-3.6-flash` stopped at 20 requests a day. The limit for the deployed model has not been measured.

How answers are made safe: the model returns claims as JSON. Each claim is checked only against the passages it cites, for numbers, fiscal labels, names, direction of change, verdict words and word overlap. Failing claims are removed and the reader is told. If none survive, or the provider fails, the answer falls back to labelled direct quotes. On ordinary questions the model never receives filed figures or verdicts. Guidance questions work differently: see Guidance questions below. In both cases its output never changes a figure or verdict.

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
- On ordinary questions the model can't see filed results, so it can't say how guidance turned out. The UI says so and points to Said vs delivered.
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

## Guidance questions

A question that asks how guidance turned out gets a comparison card instead of a document search. `domain/outcome.ts` detects the question and selects rows from the existing ledger; it never assigns a verdict, and it can only lower a row to "not tested". All values and verdicts stay in `domain/guidance.ts`. Other questions never load the ledger.

- **Card:** the management quote with speaker, call and page; the filed figure with basis and formula; the gap and verdict; and separate citations for the transcript, the filing and the comparison filing. One target repeated across calls is shown once, from the latest call.
- **Nothing comparable:** the reader is told, and the question goes to document search as before.
- **Filed data:** the saved analysis while fresh (48 hours), otherwise live with a 30-second budget. Annual reports are not read.
- **Model explanation (optional):** it reads the computed result plus passages from the calls behind the verdict, and may only add what management said around it. It is thrown away whole if it states any verdict, even the correct one, gives advice, repeats a guided number as a reported one, uses a causal phrase its source doesn't use, or fails the claim checks. A filing can't be the citation for what management said. The card is unchanged if the model fails.

| Check on production | Result |
|---|---|
| L&T, FY26 revenue growth | Guided 15%, filed 11.79%, missed by 3.21 points; consolidated and standalone (7.84%) both miss |
| L&T, FY27 revenue growth | Guided 10% to 12%, not yet due, no filed figure |
| Supreme, EBITDA margin | 13.85% to 14.77% against 14.5% to 15%, no verdict |
| Ratnamani, EBITDA margin | 17.73% to 19.18% against 16% to 18%, no verdict |
| Bajaj Finance, AUM; KEI, revenue; IRCTC, all guidance | No verdict, told so, then document search |
| Blue Dart, revenue | No comparable statement extracted, told so |
| Goldbees (no documents) | No verdict, told so |
| Figures recalculated from raw XBRL | L&T 11.79%, Supreme 13.85%, Ratnamani 17.73% and 19.18% all match |
| Quotes against the transcript PDF | L&T (3) and Supreme (1) verbatim on the cited page |
| Said vs delivered, financials, signals | Unchanged |
| Combined answer time | 1.8 to 13 s first ask, 0.3 to 0.4 s repeat, 4.7 to 7.6 s with a live ledger, 10.5 s on an unfamiliar ticker that then fell through to search |

Reading the first production answers against their sources found three faults the tests had missed, all now fixed: a management statement cited to a filing, "pipeline" given as the reason for revenue guidance when the transcript ties it to order inflow, and a margin target called "supported by" price rises where the transcript sets them apart. A future plant-level rupee target (KEI's Sanand) also read as company guidance, because no filed period yet exists to check its scale; such targets are now listed as not tested.

Limits:

- A company usually has no testable guidance. In the saved 19-company analysis, verdicts are rare, so "no verdict" is the most common honest result.
- The model can still misread a passage. The checks catch verdicts, numbers and borrowed causal phrases, not every wrong framing, so the page says to open the source.
- About one in two explanations was withheld by the checks in testing (small sample), leaving the card alone.
- A rule-extracted statement can still be mis-scored on a company not read by hand. Detection is by keyword, so an unusual wording goes to document search, and some off-topic questions using both "guidance" and "against" will show a comparison.
- Only the ledger's top 14 statements from up to six calls are considered. A statement dropped by that limit reads as not found.
- Short follow-ups ("What about FY27?", "And margins?") after a guidance question keep its subject or period. Longer or vaguer follow-ups go to document search.
- Periods written as "financial year '26" or "2025-'26" are not recognised by extraction, so such statements are listed as untestable (seen on Cummins). This loses verdicts; it does not create wrong ones.
- Transcript labels are the month a transcript was listed, not the call date: L&T's "Aug 2026" call was held on 28 July 2026. Guidance answers now say "transcript listed for"; Said vs delivered and ordinary answers still show the bare month.

## Final audit, 2 Nov 2026

| Check | Result |
|---|---|
| L&T FY26 consolidated revenue growth | 11.79%: ₹2,858,743.6 m vs ₹2,557,344.5 m, NSE XBRL tagged Consolidated |
| L&T FY26 standalone revenue growth | 7.84%: ₹1,536,801.7 m vs ₹1,425,090.1 m, tagged Standalone |
| Supreme FY26 EBITDA margin | 13.85% consolidated without other income; 14.77% standalone with ₹1,026.6 m other income |
| L&T FY27 guidance | "10% to 12% revenue growth", P. Ramakrishnan, p.11 of the 28 July 2026 call transcript; company-wide; not yet due |
| Follow-ups and hard questions on production | L&T FY26, then "What about FY27?"; Supreme "achieved?"; "Why did management miss its target?"; "Compare expectations with actual performance"; the same on Cummins: correct path each time, missing evidence stated |
| "Why" questions | Answer says filings show the outcome, not its cause |
| Reliability, 2 rounds | 11 research requests (cold, warm, 4 concurrent, keep-alive and closed) and 7 idle-socket reuses up to 60 s: all 200 with valid JSON from bom1 |
| Production 5xx, last 5 hours | Only the five Phase 2 monitoring 503s, fixed then |
| Mobile 390 px, desktop 1280 px | No overflow, no page errors |

The two connection resets seen during Phase 3 testing are unresolved. Both came from the test script, not a browser. Vercel's request log has no record of the failed request at 12:25 IST, so it did not reach the app; retries succeeded. They could not be reproduced in two controlled rounds.

A production deploy once exited without deploying; it was caught by checking the deployment ID and redeployed.

## Monitoring

**Status: automatic execution verified.** The first unattended run happened at 17:34:28 IST on 2 Nov 2026, inside the 17:30–18:30 window. It was recorded with trigger `cron` and status success: 19 of 19 companies, 34 filings checked, 9 new events, session 2 Nov, finished in 4 s. Vercel's request log independently shows `GET /api/cron/monitor` at 17:34:27 IST returning 200 on the production deployment. No manual run was made that day after 08:38 IST, and nothing was deployed during the window.

Pipeline: Vercel Cron (`0 12 * * *`) calls `/api/cron/monitor`, which needs `CRON_SECRET`. The route reads NSE announcements and Yahoo end-of-day prices directly, classifies and deduplicates, and stores one small JSON document in a private Vercel Blob store (`finn-monitor`, bom1). `/api/monitor` is the public, read-only view, shown in the Daily monitoring section on Alerts.

- **Interval:** once a day. Hobby allows no more, and may run the job at any point in the scheduled hour. Delivery is best effort and a failed run is not retried, so each run reads back to the last good scan (3 to 7 days).
- **Scope:** the 19-company demo portfolio, at ±4% and 2×. A person's own portfolio and thresholds stay on their device and are checked only when Alerts is open. There are no accounts, so they cannot be monitored in the background.
- **Stored:** run records (attempts, outcome, counts, errors, latest session) and events: filing number, classification, short summary, source link and time; or company, session, value, threshold and close. No filing text.
- **Routine filings:** stored and available in a collapsed list, not shown among material events.
- **Deduplication:** by NSE filing number, including filings clustered under another, and by company, session and signal type. Writes are conditional on the version read, and a losing writer re-reads and merges.
- **Honest states:** a scan never uses the cache or snapshot. Success needs every source read. Otherwise it is partial or failed, and the last complete scan is kept. An empty market-wide filings response counts as a failed read. Findings from before monitoring began are labelled.
- **Non-trading days:** weekends are identified, and a session already scanned adds nothing. There is no exchange calendar, so a weekday without bars is shown as "a market holiday, or not published yet".

| Check | Result |
|---|---|
| No secret, wrong secret, unprefixed secret, forged cron headers | 401 on production |
| POST with the secret; no secret configured | 405; refused (tests) |
| First manual run on production | Success: 19 of 19 companies, 81 portfolio filings, 72 events |
| Immediate repeat | Success, 0 new |
| Two simultaneous runs | Both finished, 0 new, no duplicates |
| Results after fresh deployments | Retained, no duplicates |
| 10 stored signals against `/api/quotes` | No mismatch |
| Own thresholds, 4% to 1% | Inbox 30 to 69; scheduled rule unchanged |
| Failed, partial, stale, never-run and store-down panels (mocked responses) | Each warns or says no scan has completed; only a complete scan says nothing was found |
| Store unavailable | 503; nothing reported as scanned |
| A new filing and new signals | Unit tests only: no new genuine event appeared during verification |

Not verified:

- Runs after the first. Hobby gives no retry, so a single missed day shows as stale on Alerts.

Limits: Blob on Hobby is free up to 1 GB, 10,000 simple and 2,000 advanced operations a month. Over that it stops for up to 30 days without charge, and the panel says the record can't be read. Status reads are cached for 60 seconds to stay well inside this. Monitoring does not send push notifications: findings appear when the app is opened.

Snapshots are still refreshed by hand: `npm run ingest`, commit, deploy. Research uses the saved analysis for 48 hours after a refresh, then runs live. Nothing commits to the repo automatically.

## Phone notifications (installable app, test push only)

FINN is installable (manifest, 192/512 and maskable icons, standalone display, FINN theme colours) and can receive real Web Push notifications. Delivery is limited to an operator-sent TEST message. Monitoring does not send notifications, and none of the 72 stored events has been or will be pushed.

- **Service worker** (`public/sw.js`): handles push and notification taps only. It has no fetch handler and no cache, so financial data, citations and monitoring status always come from the network as before. It is served with `no-cache`, and an update activates on the next visit.
- **Opt-in:** permission is requested only when "Turn on" is pressed on Alerts. The panel shows on, off, blocked, unsupported, or unavailable when the server has no keys. A browser that holds a subscription re-registers it on load; the same endpoint is stored once.
- **Storage:** the same private Blob store as monitoring, but a separate document (`push/subscriptions.json`) that monitoring never reads. Each record holds the endpoint, keys, a creation time and a 12-hex-character id; there is no user agent, IP or account. Writes are conditional on the version read, and losers retry, so simultaneous subscribe and unsubscribe calls both survive. A cap of 500 devices applies. There is no API that returns the list.
- **Input checks:** an endpoint must be https on a known push service (FCM, Mozilla, Apple, Windows), with no credentials or port, so the server can't be made to fetch any other host. It is checked again at send time. Keys must be a 65-byte P-256 point and a 16-byte secret. Bodies are capped at 4 KB, requests must be same-origin, and each client is limited to 10 a minute.
- **Sending:** `web-push` produces VAPID-signed, aes128gcm-encrypted messages with an 8 s timeout, TTL of 10 minutes and high urgency. Batches are capped at 50 with 4 sends at a time. A 404 or 410 deletes the subscription. Logs carry the short id and status code only.
- **Test send:** `POST /api/push/test` needs `PUSH_ADMIN_SECRET`, which never reaches the browser. It fails closed without the secret and sends to the single device code shown on that phone. The limit is 5 per hour per device with at least 20 s between sends. It can't broadcast.
- **Tap:** opens `/alerts` or `/research/{SYMBOL}` on FINN's own origin only, both in the payload check and in the worker. An open FINN window is reused.

| Check | Result |
|---|---|
| Real delivery, desktop Chrome, every FINN tab closed | FCM accepted (201). Chrome recorded "Push message received, encrypted, success", "Push event dispatched" and "Push event completed: Success", with the TEST payload decrypted intact |
| Same subscription after the browser unsubscribed | FCM 410, mapped to "expired" for deletion |
| Turn on with the store unavailable | Error shown; no browser subscription left behind |
| Permission denied | "Blocked in browser settings" with how to undo it |
| Pages served by the service worker | 0 responses on Brief, Watchlist, Alerts and L&T research |
| 390 px and 1280 px | No overflow, no page errors |
| Cron schedule and monitor route | Unchanged; tests assert this |
| Production, desktop Chrome through the real UI (2 Nov, 18:59 IST) | Turn on gave a device code. After a reload the device was still on with the same code. With no FINN tab open, an authenticated test send got FCM 201, and Chrome recorded the encrypted push received, dispatched and completed. An immediate repeat got 429. Turn off removed the record, and a later send got 404 |
| Production refusals | Test send without auth or with a wrong secret: 401. GET: 405. Cross-site subscribe: 403. Internal-host endpoint or malformed body: 400. Cron route without secret: still 401 |

On a flaky connection, Turn on once took 37 s and once failed with "Failed to fetch" after a connection reset; the panel showed the error and offered Turn on again. Subscribing through FCM alone took 4.4 s.

Not verified here: whether the notification appears on screen. The automated Chrome used for testing showed no notifications at all, even from a direct `showNotification` call, and Chrome logged its generic fallback. Display and tap navigation must be confirmed on a real phone.

## Other checks

| Check | Result |
|---|---|
| Unit tests, lint, typecheck, build | 238 tests pass (20 for push); others clean |
| Commit identity | All commits `Vishalkumar2006 <vishku2004@gmail.com>`, no AI trailers |
| Secrets in Git history | Pattern scan found none; no env files, logs or PDFs tracked |

## Not verified

- Phone timings after the performance work. The app was opened on a physical Android phone before it; mobile results here are Chrome device emulation.
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


1. Review the AI build history and attach it. Copy kept outside the repo in `C:\Users\vishk\Projects\finn-ai-build-history`.
