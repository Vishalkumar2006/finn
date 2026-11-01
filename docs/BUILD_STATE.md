# Build state

Last updated 1 Nov 2026.

## Status

The application is complete and works locally on a production build. It is not deployed or pushed yet.

## Blockers needing the owner

1. **Vercel login**: `npx vercel login`, then `npx vercel deploy --prod`. Temporary deployments were refused.
2. **GitHub**: confirm repo name and visibility, then push.
3. **Optional LLM key**: set `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` on the host.
4. **AI build history**: export the Claude Code session for the submission.
5. **Email**: send to assessment@enam.com, subject "ENAM - IIT screening - 2027". Draft in `docs/SUBMISSION.md`.

## Verified

| Check | Result |
|---|---|
| Unit tests | 89 pass |
| Lint, typecheck, production build | Pass |
| Portfolio tickers | 19 verified against Yahoo and NSE; last session 30 Oct 2026 |
| Brief on genuine filings | Live NSE data, 24h and 7d, in a browser |
| EOD signal on real data | Trent +5.4% on 3.86× volume, 30 Oct 2026 |
| XBRL against the filed PDF | Tata Elxsi Q2 FY27 revenue, expenses, PBT and PAT match |
| Answer from an annual report | Supreme FY26 report, statutory auditors, pp. 19-31 |
| Guidance vs actual | L&T: 15% guided on two calls, 11.79% filed (7.84% standalone), read in source context. HAL: 7-8% guided, 9.37% filed, read in source context. Supreme: 14.5-15% guided, 13.85-14.77% filed, no verdict |
| Unfamiliar tickers | RATNAMANI end to end; 16 of 17 in a wider scan (LTIM: no filings found, reported as such) |
| Invalid ticker | Clean empty result and error |
| Mobile | No horizontal overflow at 390px in headless Chrome emulation; no console errors |

## Not verified

- The public deployment, and whether NSE answers from a datacenter IP. If it refuses, the app falls back to labelled snapshots, and research on tickers outside the snapshot fails with an error.
- The scheduled GitHub Action has never run. The snapshot in the repo came from a manual `npm run ingest`.
- The LLM path has never called a real provider. Only its number validator is tested.
- A physical phone.
- Desktop layout has not been visually reviewed.

## Accuracy findings from manual review

Reading scored claims in context found false verdicts that are now fixed, each with a regression test:

- KEI: a product-line rupee target scored against company revenue.
- IRCTC: a reported past figure scored as guidance.
- Bajaj Finance: AUM growth scored as revenue growth.
- Sona: a revenue share scored as growth.
- Supreme: "missed" held only on one EBITDA definition.
- L&T: "10% and 15% respectively" read as 10% revenue growth, and a P&M business margin treated as company-wide.

Only a sample of scored claims was reviewed, and rules can still misfire. New companies may surface new error types.

## Next actions

1. Deploy and test the deployed flows on a phone.
2. Push, then run the ingest workflow once by hand.
3. Add an LLM step for extracting guidance, validated against source text, to raise coverage.
