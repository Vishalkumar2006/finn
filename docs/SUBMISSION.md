# Submission draft

To: assessment@enam.com
Subject: ENAM - IIT screening - 2027

---

Hello,

My submission for the FINN build challenge:

- Prototype: [DEPLOYED URL]
- Repository: [GITHUB URL]
- AI build history: [ATTACHMENT OR LINK]. I built this with Claude Code.

**What I built**

FINN is a mobile-first web app with one journey: an important event, why it matters, its source, then the company research behind it.

- Brief: every filing across a 19-stock portfolio for a chosen window, with material items first and routine ones collapsed. Results show Revenue, EBITDA, PBT and PAT against the last quarter and the same quarter a year ago. Appointments show the career profile from the filing.
- Alerts: price and volume thresholds you set, checked on end-of-day data, plus the filing types you choose.
- Research: works on any NSE ticker with filings. Said vs delivered sets management's statements from transcripts against filed numbers. You can also ask the documents a question and follow up.

**Key decisions**

- Numbers come from XBRL, not from a model reading PDFs. NSE publishes tagged results, so every figure is exact, carries its period and basis, and costs nothing to extract. I checked one filing line by line against its PDF.
- Testing management against filings is the core. L&T reaffirmed 15% FY26 group revenue growth on two calls; filings show 11.79%.
- Declining to judge is a feature. A verdict must hold on both consolidated and standalone numbers, and with and without other income. Supreme Industries guided a 14.5-15% margin for FY26. Filings give 13.85% to 14.77% depending on the definition, so FINN shows the range and gives no verdict.
- Every claim opens its evidence: the quote, the page and a link to the original filing.
- No LLM is required. Retrieval is BM25, and without a key answers are verbatim quotes, labelled as such. An optional model layer can phrase answers, and it is rejected if it states a number absent from the sources.

**Trade-offs**

Rule-based guidance extraction is cheap and auditable, but it leaves most statements as "can't test". Across the 24 companies in the snapshot, only two companies get clean verdicts (L&T and HAL), and Supreme is definition-dependent. Reading scored claims in context caught several false verdicts, each now covered by a test. The rules can still make mistakes on companies I haven't read.

I used NSE rather than BSE because BSE's API refused automated access, and I did not disguise the client. LinkedIn is login-walled, so bios come from the filing itself.

**Deliberately left out**

Unattended monitoring, phone and email notifications, user accounts, OCR for scanned PDFs, segment mix, and dedicated balance-sheet views beyond the annual table. Alerts and settings stay on one device. EOD data is never presented as intraday.

**Where I'd take it next**

Use a cheap model for guidance extraction, validated against source text, to raise coverage. Reconcile EBITDA to each company's own definition. Add real push notifications, then track how management's record changes over time.

**Not yet verified**

[UPDATE BEFORE SENDING: scheduled job, LLM layer, and any deployment limits found.]

Regards,
[NAME]
