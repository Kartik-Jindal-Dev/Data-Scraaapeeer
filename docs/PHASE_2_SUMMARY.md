# Phase 2 Summary — Discovery + Geocoding (Free Stack)

**Status:** ✅ Complete  
**Tests:** 90/90 passing (34 new + 56 from Phase 1)  
**Next phase:** Phase 3 — Website Scraping (Homepage)

---

## What Was Implemented

Phase 2 delivers the full discovery pipeline: location validation via Nominatim, business discovery via Playwright on Google Maps, and in-memory deduplication. The pipeline orchestrator wires these together and is ready for Phase 3 to plug in website scraping.

---

## What Changed (Free Stack Switch)

| Component | Before (Phase 1 stub) | After (Phase 2) |
|-----------|----------------------|-----------------|
| Geocoding | Placeholder returning `'US'` | **OpenStreetMap Nominatim** — free, no API key |
| Discovery | `runPipelineStub()` — 100ms delay, no data | **Playwright on Google Maps** — real scraping |
| Stop handler | Stub with no browser to close | **`signalStop()` + `forceCloseBrowser()`** wired in |
| Pipeline | Stub that set status to `completed` | **Real orchestrator** — geocode → discover → dedup |

**Removed entirely:** Outscraper API, Google Geocoding API. No paid dependencies.

---

## Files Created

```
backend/src/pipeline/
├── geocoder.ts           — Nominatim location validation + retry + ISO code extraction
├── discovery.ts          — Playwright Google Maps scraper (scroll + click + extract)
├── deduplicator.ts       — tldts root domain extraction + dedup key builder
├── pipeline.ts           — Job orchestrator (geocode → discover → dedup → Phase 3 stub)
├── geocoder.test.ts      — 13 tests (cleanLocationQuery + geocodeLocation)
└── deduplicator.test.ts  — 21 tests (extractRootDomain + buildDedupKey + isDuplicateLead)
```

**Updated (Phase 1 files replaced, not modified in-place):**
```
backend/src/routes/start.ts  — real Nominatim geocoder + runPipeline() wired in
backend/src/routes/stop.ts   — signalStop() + forceCloseBrowser() wired in
backend/package.json         — added: crawlee ^3.10.1, playwright ^1.45.1
```

---

## Key Logic Decisions

**Nominatim retry strategy** — The geocoder retries only when the cleaned query differs from the original. "London" is already clean so no retry fires. "London, UK!!" cleans to "London, UK" and retries. This avoids a redundant second request for already-clean inputs.

**Discovery scroll loop** — Scrolls the `[role="feed"]` element in 1000px increments with a 1.5s pause. Stops when: (a) result count reaches MAX_LEADS, (b) 3 consecutive scrolls produce no new results, or (c) stop signal is set. This handles both short result sets and full 100-result pages.

**CAPTCHA handling** — Checked on initial page load and before every card click. On detection: increments `captcha_blocked`, emits SSE `error` event with a user-facing message, and breaks out of the extraction loop. The browser is closed in the `finally` block. No auto-solve attempted.

**Stop signal** — A shared `{ stopped: boolean }` object is passed by reference into `discoverLeads()`. The stop handler sets `stopSignal.stopped = true` and then waits up to 10 seconds for the pipeline to notice and exit cleanly. After 10 seconds, `forceCloseBrowser()` is called regardless.

**Dedup key with no-key passthrough** — `buildDedupKey('', '')` returns `'|'`. The store's `isDuplicate()` treats `''` and `'|'` as non-keys and always returns `false`, so businesses with no phone and no website are never incorrectly deduplicated.

**Phase 3 placeholder** — After dedup, `pipeline.ts` logs the count of unique leads and sets status to `completed`. The `TODO Phase 3` comment marks exactly where website scraping, email/phone extraction, filter, and SSE `lead` events will be inserted.

---

## Constraints Verified

| Constraint | Status |
|------------|--------|
| No paid APIs | ✅ Nominatim (free) + Playwright (free) |
| Discovery uses Playwright Maps | ✅ |
| No email guessing | ✅ No email logic in Phase 2 |
| No persistent storage | ✅ All state in memory |
| Filter runs post-scrape only | ✅ No filter in Phase 2 |
| Stop terminates within 10 seconds | ✅ signalStop + 10s race + forceCloseBrowser |
| Dedup key = normalizedPhone\|rootDomain | ✅ tldts handles multi-part TLDs |
| CAPTCHA → increment metric + SSE error + stop | ✅ |
| LinkedIn excluded | ✅ Not referenced anywhere |

---

## How to Run

```bash
# Backend (no API keys needed for Phase 2)
cd backend
cp .env.example .env
npm run dev
# → http://localhost:4000

# Test a job
curl -X POST http://localhost:4000/api/start \
  -H "Content-Type: application/json" \
  -d '{"keyword":"dental clinic","location":"London, UK","depth":"homepage"}'
# → { "jobId": "..." }

# Stream events
curl -N "http://localhost:4000/api/stream?jobId=<jobId>"

# Check status
curl http://localhost:4000/api/status

# Run tests
npm test
```

---

## Known Limitations (Phase 2)

- Google Maps DOM selectors (`h1.DUwDvf`, `button[data-item-id^="phone:tel:"]`, etc.) may break if Google updates their UI. Multiple fallback selectors are used for resilience.
- Discovery produces 0 qualified leads in the export until Phase 3 wires in website scraping and the filter.
- Nominatim rate limit is 1 req/s — the 1.1s retry delay respects this. Do not add bulk geocoding.
