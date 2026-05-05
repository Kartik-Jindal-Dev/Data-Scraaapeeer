# Phase 3 Summary — Website Scraping Engine

**Status:** ✅ Complete  
**Tests:** 120/120 passing (30 new + 90 from Phases 1–2)  
**Next phase:** Phase 4 — Email/Phone Extraction + Filter + SSE Lead Events

---

## What Was Implemented

Phase 3 delivers the website scraping engine: static/dynamic page detection, HTML fetching via Cheerio (static) or Playwright (dynamic), failure handling for unreachable sites, and integration into the pipeline after deduplication. The pipeline now fetches HTML for every deduped lead that has a website URL and passes the results to a Phase 4 placeholder.

---

## Files Created

```
backend/src/pipeline/
├── detect.ts          — Static vs dynamic page detection
├── scraper.ts         — Website fetch engine + extractContactSubPageUrls scaffold
├── detect.test.ts     — 16 tests
└── scraper.test.ts    — 14 tests
```

**Updated:**
```
backend/src/pipeline/pipeline.ts  — Step 4 (website scraping) wired in after dedup
backend/package.json              — added: cheerio ^1.0.0
```

---

## Key Logic Decisions

**Two-step detection** — `detectPageType()` sends a GET with a 2-second `AbortController` timeout. If the response arrives in time and contains no JS framework markers, the HTML is returned directly (no second request needed for the Cheerio path). If the request times out or markers are found, the function returns `{ pageType: 'dynamic', html: '' }` and `scrapeDynamic()` fetches the page fresh with Playwright.

**Timeout hierarchy** — Three independent timeouts protect against hung sites:
- Detection fetch: 2s (AbortController)
- Playwright `waitUntil: 'networkidle'`: 15s
- Global per-site: 20s (`Promise.race` wrapping the Playwright work)

**Unreachable handling** — Any of the following marks a lead's website as unreachable and increments `website_unreachable`: HTTP 4xx/5xx, Playwright timeout, global timeout, login redirect URL, empty HTML from static detection. The lead is not discarded — it still passes to Phase 4 where it may qualify via the discovery-phase phone number.

**Separate scraper browser** — `scraper.ts` manages its own `scraperBrowser` / `scraperContext` instance, separate from the discovery browser in `discovery.ts`. This prevents the Maps session from interfering with website scraping. Both are closed in the pipeline's `finally` block via `forceCloseBrowser()` and `closeScraperBrowser()`.

**`extractContactSubPageUrls()` scaffold** — Parses `<a>` tags from fetched HTML and returns up to 4 internal links matching `/contact`, `/about`, `/team`, etc. This function is complete and tested. Phase 5 will call it to implement in-depth crawling.

**Stop signal respected** — The scraping loop checks `stopSignal.stopped` before each lead. On stop, the loop breaks and the pipeline calls `finishJob(jobId, 'stopped')`.

---

## Pipeline State After Phase 3

```
POST /api/start
  → Nominatim geocode
  → Playwright Maps discovery (up to 100 raw leads)
  → Deduplication (normalizedPhone|rootDomain)
  → Website scraping (detect → Cheerio or Playwright)
      ├── unreachable → website_unreachable++ → continue with empty HTML
      └── reachable   → html string stored in scrapedLeads[]
  → [Phase 4: email extraction + phone normalisation + filter + SSE lead emit]
  → finishJob('completed')
```

---

## Constraints Verified

| Constraint | Status |
|------------|--------|
| No email extraction in Phase 3 | ✅ scraper returns HTML only |
| No phone extraction in Phase 3 | ✅ |
| No filtering in Phase 3 | ✅ all leads pass through |
| No SSE lead events in Phase 3 | ✅ |
| Unreachable → metric + continue | ✅ `website_unreachable` incremented |
| 4xx/5xx → unreachable | ✅ |
| Timeout → unreachable | ✅ 2s detect + 15s Playwright + 20s global |
| Login redirect → unreachable | ✅ `isLoginRedirect()` checked |
| Stop signal respected | ✅ checked before each lead |
| Scraper browser closed on finish | ✅ `closeScraperBrowser()` in finally |
