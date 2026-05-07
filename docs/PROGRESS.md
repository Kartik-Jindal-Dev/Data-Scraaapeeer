    # Progress Tracker

    > Updated manually as each module is completed.
    > Current active phase: **COMPLETE — All 10 phases done**

    ---

    ## Phase Checklist

    ### Phase 1 — MVP Backend Scaffold ✅ COMPLETE

    | Module                                                | Status      | Notes |
    | ----------------------------------------------------- | ----------- | ----- |
    | Project scaffold (monorepo, tsconfig, package.json)   | ✅ Complete |       |
    | Express server entry point                            | ✅ Complete |       |
    | `types.ts` (Lead, JobStatus, FailureMetrics)          | ✅ Complete |       |
    | `store.ts` (in-memory leads[], reset, metrics)        | ✅ Complete |       |
    | `sse.ts` (SSE endpoint, connection tracking, cleanup) | ✅ Complete |       |
    | `exporter.ts` (sort, green highlight, .xlsx stream)   | ✅ Complete |       |
    | `/api/start` route                                    | ✅ Complete |       |
    | `/api/stop` route (10s hard timeout)                  | ✅ Complete |       |
    | `/api/status` route                                   | ✅ Complete |       |
    | `/api/stream` route                                   | ✅ Complete |       |
    | `/api/export` route                                   | ✅ Complete |       |

    **Test results: 56/56 passing**

    ---

    ### Phase 2 — Discovery + Geocoding ✅ COMPLETE

    | Module                                                             | Status      | Notes                |
    | ------------------------------------------------------------------ | ----------- | -------------------- |
    | `pipeline/geocoder.ts` (Nominatim, retry, ISO code)                | ✅ Complete | Free — no Google API |
    | `pipeline/discovery.ts` (Playwright Google Maps)                   | ✅ Complete | Free — no Outscraper |
    | `pipeline/deduplicator.ts` (normalizedPhone\|rootDomain via tldts) | ✅ Complete |                      |
    | `pipeline/pipeline.ts` (job orchestrator)                          | ✅ Complete |                      |
    | `routes/start.ts` updated (real geocoder + pipeline)               | ✅ Complete |                      |
    | `routes/stop.ts` updated (signalStop + forceCloseBrowser)          | ✅ Complete |                      |
    | CAPTCHA detection + `captcha_blocked` metric                       | ✅ Complete |                      |
    | Anti-blocking delays (2–4s + ±500ms jitter)                        | ✅ Complete |                      |

    **Test results: 90/90 passing** (Phase 1: 56, Phase 2 new: 34)

    ---

    ### Phase 3 — Website Scraping Engine ✅ COMPLETE

    | Module                                                         | Status      | Notes                                      |
    | -------------------------------------------------------------- | ----------- | ------------------------------------------ |
    | `pipeline/detect.ts` (static vs dynamic detection, 2s timeout) | ✅ Complete | JS marker check + login redirect detection |
    | `pipeline/scraper.ts` — Cheerio path (static pages)            | ✅ Complete | Reuses HTML from detectPageType()          |
    | `pipeline/scraper.ts` — Playwright path (dynamic pages)        | ✅ Complete | 15s load timeout + 20s global timeout      |
    | `pipeline/scraper.ts` — unreachable handling                   | ✅ Complete | 4xx/5xx/timeout/login → metric + continue  |
    | `pipeline/scraper.ts` — `extractContactSubPageUrls()`          | ✅ Complete | Scaffold for Phase 5 in-depth crawl        |
    | `pipeline/pipeline.ts` updated (Step 4 wired in)               | ✅ Complete | Scrapes all deduped leads with websites    |
    | `closeScraperBrowser()` in pipeline finally block              | ✅ Complete |                                            |

    **Test results: 120/120 passing** (Phase 1: 56, Phase 2: 34, Phase 3 new: 30)

    ---

    ### Phase 4 — Extraction + Filter ✅ COMPLETE

    | Module                                                               | Status      | Notes   |
    | -------------------------------------------------------------------- | ----------- | ------- |
    | `pipeline/emailExtractor.ts` (mailto + regex + blacklist + priority) | ✅ Complete |         |
    | `pipeline/phoneNormalizer.ts` (libphonenumber-js, E.164, ISO hint)   | ✅ Complete |         |
    | `email_not_found` metric tracking                                    | ✅ Complete |         |
    | `phone_not_found` metric tracking                                    | ✅ Complete |         |
    | `pipeline/pipeline.ts` updated (Steps 5+6 wired in)                  | ✅ Complete |         |
    | `pipeline/filter.ts` (post-scrape discard, metrics, SSE emit)        | ⬜ Pending  | Phase 5 |
    | Quality tier assignment (Tier1/2/3)                                  | ⬜ Pending  | Phase 5 |
    | SSE `lead` events wired into pipeline                                | ⬜ Pending  | Phase 5 |

    **Test results: 167/167 passing** (Phase 1: 56, Phase 2: 34, Phase 3: 30, Phase 4 new: 47)

    ---

    ### Phase 5 — Filter + Quality Tier + SSE Lead Events ✅ COMPLETE

    | Module                                                        | Status      | Notes                  |
    | ------------------------------------------------------------- | ----------- | ---------------------- |
    | `pipeline/filter.ts` (post-scrape discard, metrics, SSE emit) | ✅ Complete |                        |
    | Quality tier assignment (Tier1/2/3)                           | ✅ Complete |                        |
    | `_hasBoth` flag set correctly                                 | ✅ Complete |                        |
    | SSE `lead` events wired into pipeline                         | ✅ Complete | Public fields only     |
    | SSE `discard` events wired into pipeline                      | ✅ Complete |                        |
    | `pipeline/pipeline.ts` updated (Steps 5+6+7 combined)         | ✅ Complete | Full pipeline complete |

    **Test results: 189/189 passing** (Phase 1: 56, Phase 2: 34, Phase 3: 30, Phase 4: 47, Phase 5 new: 22)

    ---

    ### Phase 6 — Frontend Dashboard ✅ COMPLETE

    | Module                                                     | Status      | Notes                                       |
    | ---------------------------------------------------------- | ----------- | ------------------------------------------- |
    | `frontend/package.json` (Next.js 14, React 18, Tailwind 3) | ✅ Complete | Next.js 14.2.30 (patched)                   |
    | `frontend/src/types.ts` (Lead, JobStatus, SSE payloads)    | ✅ Complete |                                             |
    | `frontend/src/hooks/useSSE.ts` (EventSource hook)          | ✅ Complete | lead/discard/status/error                   |
    | `frontend/src/components/InputPanel.tsx`                   | ✅ Complete | keyword, location, depth, Start/Stop        |
    | `frontend/src/components/StatusBar.tsx`                    | ✅ Complete | live status, lead count, discard count      |
    | `frontend/src/components/ResultsTable.tsx`                 | ✅ Complete | 5 columns, green highlight for both-contact |
    | `frontend/src/components/ExportButton.tsx`                 | ✅ Complete | triggers /api/export download               |
    | `frontend/src/app/page.tsx` (Dashboard)                    | ✅ Complete | wires all components + SSE                  |
    | `frontend/src/app/layout.tsx`                              | ✅ Complete |                                             |
    | TypeScript type check                                      | ✅ 0 errors | `npx tsc --noEmit`                          |

    ---

    ### Phase 7 — Excel Export ✅ COMPLETE (implemented in Phase 1)

    | Module                                                    | Status      | Notes                                    |
    | --------------------------------------------------------- | ----------- | ---------------------------------------- |
    | `backend/src/exporter.ts` — buffer writer (≤500 leads)    | ✅ Complete | Phase 1                                  |
    | `backend/src/exporter.ts` — streaming writer (>500 leads) | ✅ Complete | Phase 1                                  |
    | Sort: `_hasBoth` first (Tier1 leads at top)               | ✅ Complete | Phase 1                                  |
    | Green row highlight for Tier1 leads                       | ✅ Complete | Phase 1                                  |
    | Website column as clickable hyperlink                     | ✅ Complete | Phase 1                                  |
    | Header styling + frozen row + autofilter                  | ✅ Complete | Phase 1                                  |
    | `GET /api/export` route                                   | ✅ Complete | Phase 1                                  |
    | Internal fields excluded from export                      | ✅ Complete | `_hasBoth`, `_qualityTier` never written |
    | `exporter.test.ts` — 12 tests                             | ✅ Complete | Phase 1                                  |

    **No code changes required — all Phase 7 requirements were already implemented and tested in Phase 1.**

    ---

    ### Phase 8 — In-Depth Crawl

    ---

    ### Phase 8 — In-Depth Crawl ✅ COMPLETE

    | Module                                               | Status      | Notes                                                      |
    | ---------------------------------------------------- | ----------- | ---------------------------------------------------------- |
    | `pipeline/indepth.ts` — `scrapeInDepth()`            | ✅ Complete | homepage + max 3 sub-pages, 30s timeout                    |
    | `pipeline/indepth.ts` — stop signal support          | ✅ Complete | checked before each sub-page                               |
    | `pipeline/indepth.ts` — duplicate URL guard          | ✅ Complete | Set-based visited tracking                                 |
    | `pipeline/indepth.ts` — merged HTML output           | ✅ Complete | PAGE_BREAK separator                                       |
    | `subpages_scraped` metric in `types.ts` + `store.ts` | ✅ Complete | incremented per successful sub-page                        |
    | `pipeline/pipeline.ts` updated (depth branch)        | ✅ Complete | `indepth` → `scrapeInDepth()`, `homepage` → `scrapePage()` |
    | `pipeline/indepth.test.ts` — 14 tests                | ✅ Complete |                                                            |

    **Test results: 200/200 passing** (Phase 1–7: 189, Phase 8 new: 11)

    ---

    ### Phase 9 — Anti-Blocking ✅ COMPLETE

    | Module                                                | Status      | Notes                                             |
    | ----------------------------------------------------- | ----------- | ------------------------------------------------- |
    | `pipeline/antiBlocking.ts` — `createStealthBrowser()` | ✅ Complete | playwright-extra + stealth plugin                 |
    | `pipeline/antiBlocking.ts` — `pickUserAgent()`        | ✅ Complete | 9-UA pool, random rotation                        |
    | `pipeline/antiBlocking.ts` — `pickViewport()`         | ✅ Complete | 5-viewport pool, random rotation                  |
    | `pipeline/antiBlocking.ts` — `getExtraHeaders()`      | ✅ Complete | Sec-Fetch-\*, Accept-Language, etc.               |
    | `pipeline/antiBlocking.ts` — `getProxyConfig()`       | ✅ Complete | env-based, optional, SOCKS5 + HTTP                |
    | `pipeline/discovery.ts` updated (stealth browser)     | ✅ Complete | launch site only — logic unchanged                |
    | `pipeline/scraper.ts` updated (stealth browser)       | ✅ Complete | launch site only — logic unchanged                |
    | `backend/.env.example` updated                        | ✅ Complete | removed stale paid API keys, documented PROXY_URL |
    | `pipeline/antiBlocking.test.ts` — 19 tests            | ✅ Complete |                                                   |

    **Test results: 219/219 passing** (Phase 1–8: 200, Phase 9 new: 19)

    ---

    ### Phase 10 — Compliance & Operations ✅ COMPLETE

    | Module                                                   | Status      | Notes                       |
    | -------------------------------------------------------- | ----------- | --------------------------- |
    | `logger.ts` — file transport (logs/app.log)              | ✅ Complete | 10MB rotation, 5 files      |
    | `middleware/rateLimiter.ts` — 5 req/min/IP on /api/start | ✅ Complete | express-rate-limit          |
    | `routes/start.ts` — rate limiter wired in                | ✅ Complete |                             |
    | `pipeline/robots.ts` — robots.txt checker                | ✅ Complete | fail-open, per-domain cache |
    | `pipeline/scraper.ts` — robots check wired in            | ✅ Complete | before scrapePage()         |
    | `index.ts` — trust proxy for correct IP detection        | ✅ Complete |                             |
    | `.env.example` — RESPECT_ROBOTS_TXT documented           | ✅ Complete |                             |
    | `docs/RUNBOOK.md` — operational runbook                  | ✅ Complete |                             |
    | `pipeline/robots.test.ts` — 14 tests                     | ✅ Complete |                             |

    **Test results: 233/233 passing** (Phase 1–9: 219, Phase 10 new: 14)

    ---

    ### Phase 11 — Speed Optimizations ✅ COMPLETE

    | Module                                                 | Status      | Notes                                          |
    | ------------------------------------------------------ | ----------- | ---------------------------------------------- |
    | **Tier 1 — Config**                                    |             |                                                |
    | `REQUEST_DELAY_MS` reduced 2000→500ms                  | ✅ Complete | `.env` default                                 |
    | `REQUEST_DELAY_JITTER_MS` reduced 500→200ms            | ✅ Complete | `.env` default                                 |
    | `SCRAPE_CONCURRENCY` set to 10                         | ✅ Complete | `.env` default                                 |
    | `RESPECT_ROBOTS_TXT` set to false                      | ✅ Complete | `.env` default                                 |
    | `PLAYWRIGHT_LOAD_TIMEOUT_MS` 15s→8s (env-configurable) | ✅ Complete | `scraper.ts`                                   |
    | `GLOBAL_SITE_TIMEOUT_MS` 20s→12s (env-configurable)    | ✅ Complete | `scraper.ts`                                   |
    | `DETECTION_TIMEOUT_MS` 2s→1s (env-configurable)        | ✅ Complete | `detect.ts`                                    |
    | **Tier 2 — Code**                                      |             |                                                |
    | Inline list extraction (no per-place navigation)       | ✅ Complete | `discovery.ts` — `extractFromList()`           |
    | Fallback navigation only for missing phone+website     | ✅ Complete | `discovery.ts` — `extractFromDetailPanel()`    |
    | Streaming pipeline (scrape+extract+emit per batch)     | ✅ Complete | `pipeline.ts` — single batch loop              |
    | Playwright page pool for dynamic scraping              | ✅ Complete | `scraper.ts` — `checkoutPage()`/`returnPage()` |
    | `.env.example` updated with all new variables          | ✅ Complete |                                                |

    **Expected performance: ~1–2 minutes for 50 leads (was 5–8 minutes)**

    ---

    ### Phase 12 — Location Engine ✅ COMPLETE (updated: global support)

    | Module                                                           | Status      | Notes                                      |
    | ---------------------------------------------------------------- | ----------- | ------------------------------------------ |
    | `CityEntry` (+ `country` field) + `CityPool` types in `types.ts` | ✅ Complete |                                            |
    | `StateEntry` type exported from `cityPool.ts`                    | ✅ Complete | name, country, lat, lon                    |
    | `getStates(country)` — Nominatim admin region fetch              | ✅ Complete | cache → Nominatim → []                     |
    | `buildCityPool(country, state)` — global city pool               | ✅ Complete | cache → Nominatim → bootstrap              |
    | `buildMultiStateCityPool(country, states[])` — multi-region      | ✅ Complete | globally compatible                        |
    | Unified cache (states + cities, 7-day TTL)                       | ✅ Complete | keys: `states:{CC}`, `cities:{CC}:{state}` |
    | Bootstrap fallback (10 common countries, 5–8 cities each)        | ✅ Complete | last resort only                           |
    | US-only static dataset removed                                   | ✅ Complete | replaced by dynamic resolution             |
    | Nominatim fail → cached data → empty (no crash)                  | ✅ Complete |                                            |
    | TypeScript diagnostics                                           | ✅ 0 errors |                                            |

    **Supports any country Nominatim covers (India, USA, UK, AU, CA, DE, FR, BR, MX, ZA, …). No pipeline.ts changes.**

    ---

    ### Phase 13 — Keyword Rule (1 Keyword) ✅ COMPLETE

    | Module                                                                            | Status      | Notes                                 |
    | --------------------------------------------------------------------------------- | ----------- | ------------------------------------- |
    | `backend/src/types.ts` — `JobContext.maxLeads` added                              | ✅ Complete | single stop condition field           |
    | `backend/src/store.ts` — `initJob()` accepts `maxLeads` param                     | ✅ Complete | defaults to 100                       |
    | `backend/src/routes/start.ts` — enforces exactly 1 keyword                        | ✅ Complete | returns 400 if >1 keyword sent        |
    | `backend/src/routes/start.ts` — `city_batched` mode (country + states[])          | ✅ Complete | Phase 14 controller wired here        |
    | `backend/src/routes/start.ts` — `legacy` mode (plain location strings)            | ✅ Complete | backward compatible                   |
    | `backend/src/routes/start.ts` — `maxLeads` stop condition in controller           | ✅ Complete | checked after every city job          |
    | `backend/src/routes/start.ts` — inter-job delay (`INTER_JOB_DELAY_MS`)            | ✅ Complete | optional, default 0                   |
    | `frontend/src/types.ts` — `PROFESSIONS` map (30 professions → keywords)           | ✅ Complete |                                       |
    | `frontend/src/types.ts` — `PROFESSION_LABELS` sorted list                         | ✅ Complete |                                       |
    | `frontend/src/components/InputPanel.tsx` — profession dropdown (→ 1 keyword)      | ✅ Complete | replaces multi-keyword tag input      |
    | `frontend/src/components/InputPanel.tsx` — country + states[] inputs              | ✅ Complete | replaces plain location field         |
    | `frontend/src/components/InputPanel.tsx` — maxLeads number input                  | ✅ Complete |                                       |
    | `frontend/src/app/page.tsx` — state wired to new inputs                           | ✅ Complete | profession, country, states, maxLeads |
    | `frontend/src/app/page.tsx` — sends `{keyword, country, states, maxLeads}` to API | ✅ Complete |                                       |
    | TypeScript diagnostics (all 6 files)                                              | ✅ 0 errors |                                       |

    **pipeline.ts untouched. Backward compatible: legacy `location` string mode still works.**

    ---

    ### Phase 14 — City Batching & Auto-Expansion ✅ COMPLETE

    | Module                                                                              | Status      | Notes                                                                                      |
    | ----------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------ |
    | `backend/src/types.ts` — `SseStatusPayload.batchProgress` added                     | ✅ Complete | currentBatch, totalBatches, citiesProcessed, totalCities                                   |
    | `backend/src/routes/start.ts` — batch loop hardened                                 | ✅ Complete | `outer:` label, stop-signal race fixed, `resetStopSignal` only when not externally stopped |
    | `backend/src/routes/start.ts` — batch progress emitted via SSE before each city job | ✅ Complete |                                                                                            |
    | `backend/src/routes/start.ts` — final status distinguishes stopped vs completed     | ✅ Complete |                                                                                            |
    | `backend/src/routes/start.ts` — city pool exhausted logged as partial success       | ✅ Complete |                                                                                            |
    | `backend/src/pipeline/cityPool.ts` — unused `normaliseName` removed                 | ✅ Complete |                                                                                            |
    | `frontend/src/types.ts` — `StatusPayload.batchProgress` added                       | ✅ Complete | mirrors backend shape                                                                      |
    | `frontend/src/app/page.tsx` — `batchProgress` state wired from SSE                  | ✅ Complete | reset on new job start                                                                     |
    | `frontend/src/app/page.tsx` — `maxLeads` + `batchProgress` passed to StatusBar      | ✅ Complete |                                                                                            |
    | `frontend/src/components/StatusBar.tsx` — batch/city progress display               | ✅ Complete | "Batch 2/4 · City 7/20" badge                                                              |
    | `frontend/src/components/StatusBar.tsx` — cities progress bar                       | ✅ Complete | blue bar, live update                                                                      |
    | `frontend/src/components/StatusBar.tsx` — leads progress bar                        | ✅ Complete | green bar, X/maxLeads                                                                      |
    | `backend/.env` — `CITY_BATCH_SIZE`, `CITIES_PER_STATE`, `INTER_JOB_DELAY_MS` added  | ✅ Complete |                                                                                            |
    | TypeScript diagnostics (all 6 files)                                                | ✅ 0 errors |                                                                                            |

    **pipeline.ts untouched. All batching, stop condition, and progress tracking owned by the controller in start.ts.**

    ---

    ### Phase 15 — Global Deduplication (15-Day Rolling Window) ✅ COMPLETE

    | Module                                                                                  | Status      | Notes                                                        |
    | --------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------ |
    | `backend/src/pipeline/deduplicator.ts` — rolling window `Map<string, number>`           | ✅ Complete | module-level, persists across `store.reset()`                |
    | `backend/src/pipeline/deduplicator.ts` — `cleanupRollingWindow()`                       | ✅ Complete | purges entries older than `DEDUP_WINDOW_DAYS` on every check |
    | `backend/src/pipeline/deduplicator.ts` — two-layer dedup (rolling window + per-run Set) | ✅ Complete | rolling window checked first                                 |
    | `backend/src/pipeline/deduplicator.ts` — `getRollingWindowSize()` exported              | ✅ Complete | for monitoring/tests                                         |
    | `backend/src/pipeline/deduplicator.ts` — `clearRollingWindowForTesting()` exported      | ✅ Complete | test isolation only                                          |
    | `store.ts` — per-run `dedupSet` unchanged                                               | ✅ Complete | Layer 1 untouched                                            |
    | `store.reset()` — does NOT clear rolling window                                         | ✅ Complete | cross-run dedup preserved                                    |
    | `backend/.env` — `DEDUP_WINDOW_DAYS=15` added                                           | ✅ Complete |                                                              |
    | `deduplicator.test.ts` — existing 21 tests updated for rolling window isolation         | ✅ Complete | `clearRollingWindowForTesting()` in `beforeEach`             |
    | `deduplicator.test.ts` — 6 new rolling window tests                                     | ✅ Complete | cross-run dedup, 15-day reset, no-key passthrough            |
    | All 27 tests passing                                                                    | ✅ 27/27    |                                                              |

    **Behavior: leads seen in the last 15 days are skipped across job runs. After 15 days, leads reappear. Rolling window is in-memory — lost on server restart (by design).**

    ---

    ### Phase 16 — Concurrency & Query Priority ✅ COMPLETE

    | Module                                                                             | Status                 | Notes                                        |
    | ---------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------- |
    | `backend/src/pipeline/pipeline.ts` — concurrency clamp enforced                    | ✅ Complete            | values > 6 clamped with warning log          |
    | `backend/src/pipeline/pipeline.ts` — default changed from 10 → env var (default 3) | ✅ Complete            |                                              |
    | `backend/src/pipeline/pipeline.ts` — header comment updated (Phase 16 model)       | ✅ Complete            | sequential jobs, concurrency within job only |
    | `backend/.env` — `SCRAPE_CONCURRENCY=3` (was 10)                                   | ✅ Complete            | recommended 2–4, max 6                       |
    | `backend/.env` — `INTER_JOB_DELAY_MS` comment updated with Phase 16 guidance       | ✅ Complete            | recommend 20000–30000 in prod                |
    | Sequential job execution                                                           | ✅ Already implemented | city-batched controller in start.ts          |
    | Query priority (largest cities first)                                              | ✅ Already implemented | cityPool.ts sorts by importance desc         |
    | Inter-job delay (`INTER_JOB_DELAY_MS`)                                             | ✅ Already implemented | start.ts controller                          |
    | All 252 backend tests passing                                                      | ✅ 252/252             |                                              |

    **Concurrency model: 2–4 parallel website fetches WITHIN each city job. City jobs run sequentially. Values above 6 are clamped automatically.**

    ---

    | Symbol | Meaning     |
    | ------ | ----------- |
    | ✅     | Completed   |
    | 🔄     | In Progress |
    | ⬜     | Pending     |
    | ❌     | Blocked     |

    ---

    ## Notes

    - LinkedIn is excluded from all phases (aggressive bot detection, legal risk).
    - Vercel serverless not suitable — headless browsers require persistent processes.
    - Export before restarting the server — all in-memory data is lost on restart.
    - **Free stack confirmed**: Nominatim (geocoding) + Playwright Maps (discovery). No paid APIs.
    - Phase 3 scraping engine complete — HTML fetched for all leads. Extraction wired in Phase 4.

---

### Phase 17 — Static Global Location Engine (country-state-city + GeoNames) ✅ COMPLETE

Replaced the Nominatim-based dynamic location resolution with a fully static, offline-capable system. Zero network calls for location data. Instant startup. Works for all 250 countries.

| Module                                                         | Status      | Notes                                                         |
| -------------------------------------------------------------- | ----------- | ------------------------------------------------------------- |
| `country-state-city@3.2.1` installed                           | ✅ Complete | 250 countries, all states, all cities — no API key            |
| `backend/data/cities15000.txt` downloaded                      | ✅ Complete | GeoNames ~33k cities with population field                    |
| `backend/data/admin1CodesASCII.txt` downloaded                 | ✅ Complete | Maps GeoNames numeric admin1 codes → state names              |
| `pipeline/cityPool.ts` — full rewrite                          | ✅ Complete | All Nominatim calls removed                                   |
| `loadGeoNamesData()` — population map built at startup         | ✅ Complete | 33,633 entries, loaded once synchronously                     |
| `resolveCountryIso(nameOrCode)`                                | ✅ Complete | Full name or ISO code → ISO 3166-1 alpha-2, 250 countries     |
| `getCountries()`                                               | ✅ Complete | All 250 countries with name + ISO code                        |
| `getStates(countryIso)`                                        | ✅ Complete | All states/regions for any country                            |
| `buildCityPool(iso, state)`                                    | ✅ Complete | Cities ranked by GeoNames population descending               |
| `buildMultiStateCityPool(iso, states[])`                       | ✅ Complete | Concatenates pools across multiple states                     |
| `findState()` — fuzzy state name matching                      | ✅ Complete | exact → prefix → substring → 5-char fuzzy (handles typos)     |
| `routes/start.ts` — city-batched mode uses `resolveCountryIso` | ✅ Complete | No Nominatim geocode call for ISO code                        |
| All Nominatim calls removed from `cityPool.ts`                 | ✅ Complete |                                                               |
| Bootstrap fallback removed                                     | ✅ Complete | country-state-city is the authoritative source                |
| Nominatim cache logic removed                                  | ✅ Complete | No TTL, no Map cache needed                                   |
| `NOMINATIM_CACHE_TTL_DAYS` env var removed                     | ✅ Complete |                                                               |
| `NOMINATIM_IMPORTANCE_MIN` env var removed                     | ✅ Complete |                                                               |
| `pipeline.ts` — `maxLeads` stop enforced mid-batch             | ✅ Complete | Stops scraping as soon as target is reached within a city job |
| All 252 backend tests passing                                  | ✅ 252/252  | No regressions                                                |

**Example output — India, Gujarat:** Ahmedabad (6.3M) → Surat (4.6M) → Vadodara (1.8M) → Bhavnagar (605k) → …

**Removed dependencies on:** Nominatim city fetch, Nominatim state fetch, bootstrap city lists, in-memory cache Map, TTL logic, `resolveIsoCode` name map, `COUNTRY_NAME_TO_ISO` hardcoded table.

---

### Phase 18 — maxLeads Stop Condition Inside Pipeline ✅ COMPLETE

Fixed: `pipeline.ts` was running a full city job to completion even after `maxLeads` was reached, because the stop check only existed in the outer controller (`start.ts`).

| Module                                                             | Status      | Notes                                               |
| ------------------------------------------------------------------ | ----------- | --------------------------------------------------- |
| `pipeline/pipeline.ts` — `maxLeads` check before each scrape batch | ✅ Complete | Skips remaining leads if target already met         |
| `pipeline/pipeline.ts` — `maxLeads` check after each accepted lead | ✅ Complete | Stops mid-batch the moment count hits target        |
| `ctx.maxLeads` read from `JobContext`                              | ✅ Complete | Defaults to `Infinity` if not set (backward compat) |

**Before:** With `maxLeads=50`, a city returning 120 leads would scrape all 120 before stopping.  
**After:** Scraping stops as soon as the 50th lead is accepted — remaining leads in the batch and all subsequent batches are skipped.

---

### Phase 19 — City Auto-Expansion (Full State Coverage) ✅ COMPLETE

**Problem:** The controller was capped at `CITIES_PER_STATE` (default 20) cities per state. If 40 cities across 2 states didn't yield enough leads, the job ended with a partial result — no way to continue.

**Solution:** Load the full ranked city list for each selected state (no cap). Batch through all of them in population order. Only stop when `maxLeads` is reached or every city in every selected state is exhausted. No auto-adding of new states — if all cities are done and target isn't met, report clearly.

| Module                                                                                         | Status      | Notes                                                                             |
| ---------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------- |
| `pipeline/cityPool.ts` — `getFullRankedCities(iso, state)` added                               | ✅ Complete | Returns all cities for a state, sorted by population desc, no cap                 |
| `routes/start.ts` — controller uses `getFullRankedCities` instead of `buildMultiStateCityPool` | ✅ Complete | Full city list built at job start                                                 |
| `routes/start.ts` — batch loop iterates all cities (not just first 20/state)                   | ✅ Complete | `totalCities` now reflects full count                                             |
| `routes/start.ts` — exhaustion message updated                                                 | ✅ Complete | "All cities exhausted. To get more leads, add more states or change the keyword." |
| TypeScript diagnostics                                                                         | ✅ 0 errors |                                                                                   |

**Example:** New Mexico has 182 cities available. Previously capped at 20. Now all 182 are used if needed.  
**Texas:** 1,000+ cities. **India/Gujarat:** 311 cities. System works through all of them before giving up.

**Behavior:**

- `maxLeads` reached → stop immediately, status: `completed`
- All cities exhausted, target not met → status: `completed` (partial), log message suggests adding more states
- User stops manually → status: `stopped`

---

### Phase 20 — Visited Cities Tracking ✅ COMPLETE

Prevents re-scraping cities that were already visited for the same keyword within the dedup window. Same pattern as the 15-day rolling dedup window in `deduplicator.ts`.

| Module                                                    | Status      | Notes                                                                 |
| --------------------------------------------------------- | ----------- | --------------------------------------------------------------------- |
| `pipeline/visitedCities.ts` — new module                  | ✅ Complete | Module-level `Map<string, number>` (key → visitedAt timestamp)        |
| `buildKey(keyword, city, isoCountry)`                     | ✅ Complete | Key: `${keyword}:${city}:${ISO}` (all lowercase/uppercase normalised) |
| `isCityVisited(keyword, city, iso)`                       | ✅ Complete | Returns true if visited within `DEDUP_WINDOW_DAYS`                    |
| `markCityVisited(keyword, city, iso)`                     | ✅ Complete | Records visit timestamp after job completes                           |
| `cleanup()` — purges expired entries                      | ✅ Complete | Called automatically before every check                               |
| `getVisitedCityCount()` — monitoring                      | ✅ Complete |                                                                       |
| `clearVisitedCitiesForTesting()` — test isolation         | ✅ Complete |                                                                       |
| `routes/start.ts` — skip visited cities before dispatch   | ✅ Complete | Logs skip reason, increments `citiesProcessed`                        |
| `routes/start.ts` — mark city visited after job completes | ✅ Complete |                                                                       |
| TTL matches `DEDUP_WINDOW_DAYS` (default 15 days)         | ✅ Complete | Cities re-eligible after window expires                               |
| In-memory only — lost on server restart                   | ✅ Complete | Same behaviour as rolling dedup window                                |
| All 252 backend tests passing                             | ✅ 252/252  |                                                                       |

**Behaviour:**

- Run 1 (keyword="lawyer", state="New Mexico"): scrapes Albuquerque → marks it visited
- Run 2 (same day, same keyword+state): Albuquerque is skipped → moves to next unvisited city
- Day 16+: visit window expires → Albuquerque is eligible again

**Key format:** `lawyer:albuquerque:US`  
**TTL:** `DEDUP_WINDOW_DAYS` env var (default 15 days)

---

### Speed Optimization — Phase 1: Hybrid Discovery Strategy 🔄 IN PROGRESS

Serper API integrated as primary discovery source with automatic fallback to existing Google Maps Playwright scraper. Pipeline architecture unchanged.

| Module                                                                 | Status      | Notes                                                                                |
| ---------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------ |
| `backend/.env.example` — Serper env vars added                         | ✅ Complete | `SERPER_API_KEY`, `SERPER_ENABLED`, `SERPER_RESULTS_PER_QUERY`, `SERPER_TIMEOUT_MS`  |
| `backend/.env` — Serper vars added (`SERPER_ENABLED=false` by default) | ✅ Complete | Safe default — Maps scraper used until key is configured                             |
| `backend/src/types.ts` — `FailureMetrics` updated                      | ✅ Complete | Added `serper_queries`, `serper_failures`, `serper_fallbacks`, `serper_results_used` |
| `backend/src/store.ts` — `reset()` initialises Serper metrics          | ✅ Complete | All four counters zeroed on job start                                                |
| `backend/src/pipeline/serper.ts` — new module                          | ✅ Complete | Full Serper API integration (see details below)                                      |
| `backend/src/pipeline/discovery.ts` — Serper integration point         | ✅ Complete | Serper tried first; Maps fallback on failure or insufficient results                 |
| `backend/src/pipeline/serper.test.ts` — 29 unit tests                  | ✅ Complete | All passing                                                                          |

#### serper.ts — Implemented Features

| Feature                                                                   | Status      | Notes                                                         |
| ------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------- |
| `searchSerper(query)` — main public API                                   | ✅ Complete | Returns `SerperResult[]`, empty array on any failure          |
| Runtime env var reads (`getConfig()`)                                     | ✅ Complete | Reads at call time — not module load — so tests can override  |
| Result priority: `localResults` → `places` → `knowledgeGraph` → `organic` | ✅ Complete | Structured local results preferred over organic               |
| Source attribution: `source: "serper"` on all results                     | ✅ Complete | Enables quality comparison and fallback analysis              |
| URL validation (http/https only, non-empty name required)                 | ✅ Complete | Filters out JS/FTP links and incomplete records               |
| URL deduplication (case-insensitive, trailing-slash aware)                | ✅ Complete | Prevents duplicate leads from overlapping result sections     |
| In-memory query cache (TTL: 18h, max 100 entries)                         | ✅ Complete | Key: full normalized query string; prevents quota waste       |
| `clearSerperCache()` / `getSerperCacheStats()`                            | ✅ Complete | Exported for testing and monitoring                           |
| `ConcurrencyLimiter` class (queue-based semaphore)                        | ✅ Complete | Max 3 concurrent requests; queues excess rather than dropping |
| Timeout handling (`AbortController`, configurable)                        | ✅ Complete | Default 8s; logs timeout clearly                              |
| Error handling: 429, 403, 400, network errors, bad JSON                   | ✅ Complete | All return `[]` and increment `serper_failures`               |
| `convertToRawLeads()` — shape adapter                                     | ✅ Complete | Maps `SerperResult[]` → `RawLead[]` for pipeline              |
| `validateSerperResults()` — quality gate                                  | ✅ Complete | Checks minimum website-bearing results before accepting       |

#### discovery.ts — Integration

| Feature                                                    | Status      | Notes                                                        |
| ---------------------------------------------------------- | ----------- | ------------------------------------------------------------ |
| Serper tried first when `SERPER_ENABLED=true`              | ✅ Complete | Query format: `"{keyword} {location}"`                       |
| Fallback to Maps on Serper failure or insufficient results | ✅ Complete | Minimum threshold: `Math.min(5, SERPER_RESULTS_PER_QUERY/4)` |
| `serper_fallbacks` incremented on fallback                 | ✅ Complete |                                                              |
| `serper_results_used` incremented on Serper success        | ✅ Complete |                                                              |
| Timing logs for observability (Serper duration, total)     | ✅ Complete | Logged at `info` level                                       |
| Maps scraper logic completely unchanged                    | ✅ Complete | No regressions                                               |

#### Validation

| Check                                   | Result       |
| --------------------------------------- | ------------ |
| TypeScript compilation (`tsc --noEmit`) | ✅ 0 errors  |
| Serper unit tests                       | ✅ 29/29     |
| Full backend test suite                 | ✅ 281/281   |
| No regressions in existing tests        | ✅ Confirmed |

#### Modified Files

- `backend/.env.example`
- `backend/.env`
- `backend/src/types.ts`
- `backend/src/store.ts`
- `backend/src/pipeline/serper.ts` _(new)_
- `backend/src/pipeline/discovery.ts`
- `backend/src/pipeline/serper.test.ts` _(new)_

#### Deviations from Plan

- None. All Phase 1 tasks implemented as specified in `SPEED_OPTIMIZATION_PLAN.md`.
- `SERPER_ENABLED=false` in `.env` by default (plan allowed this for safety).
- Cache key uses full normalized query string instead of `keyword|city|country` split — functionally equivalent and more robust for multi-word keywords.

---

### Speed Optimization — Phase 2: Low-Risk Pipeline Optimizations ✅ COMPLETE

| Task                                | Module                                                   | Status             | Notes                                                                   |
| ----------------------------------- | -------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------- |
| 2.1 Parallel email/phone extraction | `pipeline/pipeline.ts`                                   | ✅ Complete        | `Promise.all([extractEmail, extractPhone])` — was sequential            |
| 2.2 Shared Cheerio instance         | `emailExtractor.ts`, `phoneNormalizer.ts`, `pipeline.ts` | ✅ Complete        | Parse HTML once, pass `$` to both extractors                            |
| 2.3 HTTP compression header         | `antiBlocking.ts`                                        | ✅ Already present | `Accept-Encoding: gzip, deflate, br` was already in `getExtraHeaders()` |
| 2.4 Jitter on retry delays          | `pipeline/scraper.ts`                                    | ✅ Complete        | `baseDelay * 2^attempt + ±30% jitter`                                   |

#### Implementation Details

**2.1 — Parallel extraction (`pipeline.ts`)**

- Replaced sequential `await extractEmail()` → `extractPhone()` with `Promise.all()`
- `extractPhone` is synchronous so wrapped in `Promise.resolve()` for clean parallel form
- Expected gain: 20-30% speedup per lead (email MX DNS lookup no longer blocks phone extraction)

**2.2 — Shared Cheerio instance**

- `extractFromJsonLd(html, $?)` — added optional `$` parameter; uses pre-parsed instance if provided, falls back to `cheerio.load(html)` if not
- `extractEmail(html, website, $?)` — added optional `$` parameter; passes it to `extractFromJsonLd`
- `extractPhone(rawPhone, html, iso, name, $?)` — added optional `$` parameter; passes it to `extractFromJsonLd`
- `pipeline.ts` — parses HTML once with `cheerio.load(html)` and passes `parsed$` to both extractors
- Audit confirmed: neither extractor mutates the DOM (no `.remove()`, `.append()`, `.attr(set)` calls)
- Backward compatible: all existing call sites without `$` continue to work unchanged
- Expected gain: 5-10% CPU reduction (eliminates 1-2 redundant `cheerio.load()` calls per lead)

**2.3 — HTTP compression (`antiBlocking.ts`)**

- `Accept-Encoding: 'gzip, deflate, br'` was already present in `getExtraHeaders()` from Phase 9
- No change required — confirmed present and correct

**2.4 — Retry jitter (`scraper.ts`)**

- Changed: `delay = baseDelay * 2^attempt` → `delay = baseDelay * 2^attempt + random(0, baseDelay * 0.3)`
- Adds up to 30% random jitter on top of exponential backoff
- Prevents multiple concurrent retries from stampeding the same site simultaneously
- Note: `SCRAPE_MAX_RETRIES=0` in `.env` by default — jitter activates only when retries are enabled

#### Modified Files

- `backend/src/pipeline/pipeline.ts`
- `backend/src/pipeline/emailExtractor.ts`
- `backend/src/pipeline/phoneNormalizer.ts`
- `backend/src/pipeline/scraper.ts`

#### Validation

| Check                                   | Result       |
| --------------------------------------- | ------------ |
| TypeScript compilation (`tsc --noEmit`) | ✅ 0 errors  |
| Full backend test suite                 | ✅ 281/281   |
| No regressions                          | ✅ Confirmed |

#### Deviations from Plan

- None. All four Phase 2 tasks implemented exactly as specified.
- 2.3 was already implemented in Phase 9 (antiBlocking.ts) — noted as pre-existing, no duplicate work done.

---

### Speed Optimization — Phase 3: Medium-Risk Optimizations ✅ COMPLETE

| Task                                    | Module         | Status      | Notes                                                                                  |
| --------------------------------------- | -------------- | ----------- | -------------------------------------------------------------------------------------- |
| 3.1 Browser context pool                | `scraper.ts`   | ✅ Complete | Feature-flagged `BROWSER_POOL_ENABLED`, pool size 2–3, queue-based checkout            |
| 3.2 Robots.txt 24h TTL cache            | `robots.ts`    | ✅ Complete | Stale entries evicted on next access, `getRobotsCacheSize()` exported                  |
| 3.3 Streaming pipeline audit            | `pipeline.ts`  | ✅ Complete | Current behavior documented in module header comment                                   |
| 3.4 Dynamic scroll waiting              | `discovery.ts` | ✅ Complete | Feature-flagged `DYNAMIC_WAITS_ENABLED`, polls for DOM stability (600ms stable = done) |
| 3.5 Streaming within batches            | `pipeline.ts`  | ✅ Complete | Per-lead Promise chains + mutex for SSE ordering; `Promise.allSettled` per batch       |
| 3.6 Circuit breaker for failing domains | `scraper.ts`   | ✅ Complete | 3 failures → open for 5 min, auto-reset, `clearCircuitBreaker()` exported              |
| 3.7 Async logging                       | `logger.ts`    | ✅ Complete | `lazy: true` on file transport — defers stream open to first write                     |

#### Implementation Details

**3.1 — Browser Context Pool (`scraper.ts`)**

- `BrowserContextPool` class: queue-based semaphore, `checkout()` / `checkin()` API
- Pool size: `BROWSER_POOL_SIZE` env var (default 2, max 3 enforced in code)
- Feature flag: `BROWSER_POOL_ENABLED=false` (default) — falls back to existing single-context path
- `closeScraperBrowser()` closes pool if initialized, then single-context fallback
- `scrapeDynamic()` checks `isPoolEnabled()` at call time — no module-load side effects
- Safety: pool size capped at 3; increase only after memory profiling + CAPTCHA monitoring

**3.2 — Robots.txt 24h TTL (`robots.ts`)**

- Cache entries now store `{ content, fetchedAt }` instead of bare string
- `fetchRobotsTxt()` checks age on every access; evicts and re-fetches if stale
- TTL: `ROBOTS_CACHE_TTL_MS = 24h`
- Error/timeout responses cached briefly (same TTL) to prevent hammering unreachable robots.txt
- `getRobotsCacheSize()` exported for observability
- All existing tests pass unchanged (cache behavior is transparent to callers)

**3.3 — Streaming Pipeline Audit (`pipeline.ts`)**

- Documented in module header: batch scraping, SSE ordering, stop conditions, dedup assumptions
- Key findings: no duplicate emits (emitLead called once per lead in processLead), stop signal checked before each batch and inside mutex, dedup is per-run Set + 15-day rolling window (both checked before scraping begins)
- No code changes required — audit outcome is documentation only

**3.4 — Dynamic Scroll Waiting (`discovery.ts`)**

- `waitForFeedStable()` helper: polls feed item count every 200ms, returns when stable for 600ms or maxWaitMs exceeded
- Feature flag: `DYNAMIC_WAITS_ENABLED=false` (default) — uses fixed `SCROLL_PAUSE_MS` when disabled
- When enabled: saves 2-4s per city by avoiding unnecessary fixed waits after feed loads quickly
- Requirement honored: only enable after Serper fallback stability validation

**3.5 — Streaming Within Batches (`pipeline.ts`)**

- Replaced `Promise.all(scrape) → sequential extract loop` with per-lead Promise chains
- Each lead: scrape → extract → filter → emit, all chained independently
- Mutex (promise-chain semaphore) serializes the extract+filter+emit step to preserve SSE ordering and prevent concurrent store mutations
- `Promise.allSettled(leadPromises)` waits for all leads in batch before moving to next batch
- Expected gain: 30-40% reduction in batch idle time — frontend receives leads as each scrape completes

**3.6 — Circuit Breaker (`scraper.ts`)**

- `CircuitEntry`: `{ failures: number, openedAt: number }`
- `recordDomainFailure()`: increments counter; opens circuit after 3 failures
- `recordDomainSuccess()`: resets counter on successful scrape
- `isCircuitOpen()`: auto-resets after 5 minutes
- `scrapePage()`: checks circuit before robots.txt and DNS — fast-fail for known-bad domains
- DNS failures also increment the circuit breaker counter
- `clearCircuitBreaker()` and `getCircuitBreakerStats()` exported for testing/monitoring

**3.7 — Async Logging (`logger.ts`)**

- Added `lazy: true` to Winston file transport
- `lazy: true`: defers file stream creation to first write — no blocking I/O at startup
- Winston's file transport uses Node.js streams internally (already async); `lazy` removes the synchronous open-on-startup behavior
- Small crash-loss risk acknowledged: last ~100ms of logs may be lost on hard crash (acceptable per plan)

#### New Environment Variables

| Variable                | Default | Description                               |
| ----------------------- | ------- | ----------------------------------------- |
| `BROWSER_POOL_ENABLED`  | `false` | Enable browser context pool (Phase 3.1)   |
| `BROWSER_POOL_SIZE`     | `2`     | Pool size, max 3 enforced (Phase 3.1)     |
| `DYNAMIC_WAITS_ENABLED` | `false` | Enable dynamic scroll waiting (Phase 3.4) |

#### Modified Files

- `backend/src/pipeline/robots.ts`
- `backend/src/pipeline/scraper.ts`
- `backend/src/pipeline/discovery.ts`
- `backend/src/pipeline/pipeline.ts`
- `backend/src/logger.ts`
- `backend/.env.example`
- `backend/.env`

#### Validation

| Check                                   | Result       |
| --------------------------------------- | ------------ |
| TypeScript compilation (`tsc --noEmit`) | ✅ 0 errors  |
| Full backend test suite                 | ✅ 281/281   |
| No regressions                          | ✅ Confirmed |

#### Deviations from Plan

- None. All seven Phase 3 tasks implemented as specified.
- All risky features (3.1, 3.4) are off by default behind feature flags.
- 3.3 is documentation-only as specified — no code changes.

---

### Speed Optimization — Phase 4: Intra-City Concurrency Improvements ✅ COMPLETE

| Task                         | Module                 | Status      | Notes                                                                |
| ---------------------------- | ---------------------- | ----------- | -------------------------------------------------------------------- |
| 4.1 Higher concurrency cap   | `pipeline/pipeline.ts` | ✅ Complete | Feature-flagged `HIGHER_CONCURRENCY_ENABLED`, cap 6 → 8              |
| 4.2 Adaptive concurrency     | `pipeline/pipeline.ts` | ✅ Complete | Feature-flagged `ADAPTIVE_CONCURRENCY_ENABLED`, adjusts ±1 per batch |
| 4.3 Priority queue for leads | `pipeline/pipeline.ts` | ✅ Complete | Leads with websites sorted first, no-website leads appended last     |

#### Implementation Details

**4.1 — Higher Concurrency Cap (`pipeline.ts`)**

- `HIGHER_CONCURRENCY_ENABLED=false` (default) → hard cap stays at 6
- `HIGHER_CONCURRENCY_ENABLED=true` → hard cap raised to 8
- `SCRAPE_CONCURRENCY` env var still controls the starting value; cap clamps it
- Recommended safe range remains 4–6 regardless of cap setting
- Warning logged when `SCRAPE_CONCURRENCY` exceeds the active cap

**4.2 — Adaptive Concurrency (`pipeline.ts`)**

- `ADAPTIVE_CONCURRENCY_ENABLED=false` (default) — concurrency stays fixed at `CONCURRENCY_BASE`
- When enabled: `adaptiveState` tracks rolling `windowSuccesses`, `windowFailures`, `windowDurationMs` across batches
- Adjustment logic (runs after each batch once window has ≥ `current` samples):
  - `failureRate > 40%` OR `avgDuration > 10s` → decrease by 1 (floor: 1)
  - `failureRate < 10%` AND `avgDuration < 5s` AND `current < max` → increase by 1
  - Otherwise: hold
- Window resets after each adjustment to avoid stale data influencing future decisions
- No-website leads count as failures for adaptive purposes (they produce no HTML)
- Logs concurrency changes at `info` level: `adaptive concurrency 3 → 4 (failureRate=5% avgDuration=2100ms)`
- `CONCURRENCY` variable updated from `adaptiveState.current` after each batch

**4.3 — Priority Queue (`pipeline.ts`)**

- `prioritizedLeads = [...withWebsite, ...withoutWebsite]` — stable sort, original order preserved within each group
- Logged at `info` level when no-website leads exist: `priority sort — 18 with website (first), 2 without (last)`
- All downstream references updated from `dedupedLeads` → `prioritizedLeads`
- `dedupedLeads` still used for dedup log and as source for building `prioritizedLeads`
- No change to dedup logic, stop conditions, or SSE ordering

#### New Environment Variables

| Variable                       | Default | Description                                        |
| ------------------------------ | ------- | -------------------------------------------------- |
| `HIGHER_CONCURRENCY_ENABLED`   | `false` | Raise concurrency hard cap from 6 → 8 (Phase 4.1)  |
| `ADAPTIVE_CONCURRENCY_ENABLED` | `false` | Enable adaptive concurrency adjustment (Phase 4.2) |

#### Modified Files

- `backend/src/pipeline/pipeline.ts`
- `backend/.env.example`
- `backend/.env`

#### Validation

| Check                                   | Result       |
| --------------------------------------- | ------------ |
| TypeScript compilation (`tsc --noEmit`) | ✅ 0 errors  |
| Full backend test suite                 | ✅ 281/281   |
| No regressions                          | ✅ Confirmed |

#### Deviations from Plan

- None. All three Phase 4 tasks implemented as specified.
- Both 4.1 and 4.2 are off by default behind feature flags per plan requirements.
- 4.3 (priority queue) has no feature flag — it's a pure ordering change with no risk, consistent with plan's "Low risk" classification.

---

### Speed Optimization — Phase 5: Architectural Improvements ✅ COMPLETE

| Task                                 | Module                                        | Status      | Notes                                                                    |
| ------------------------------------ | --------------------------------------------- | ----------- | ------------------------------------------------------------------------ |
| 5.1 Parallel city job execution      | `routes/start.ts`, `pipeline/deduplicator.ts` | ✅ Complete | Feature-flagged `PARALLEL_CITIES_ENABLED`; dedup made concurrency-safe   |
| 5.2 Worker process architecture      | —                                             | ⏭ Skipped  | Dependency: persistent/shared storage required (in-memory constraint)    |
| 5.3 Work stealing                    | —                                             | ⏭ Skipped  | VERY HIGH risk — plan defers to late Phase 5 after production validation |
| 5.4 Streaming export API             | `routes/exportStream.ts`, `index.ts`          | ✅ Complete | `GET /api/export/stream` — partial results during running job            |
| 5.5 Memory-optimized HTML processing | `emailExtractor.ts`, `phoneNormalizer.ts`     | ✅ Complete | `truncateHtmlIfNeeded()` — 512KB cap before Cheerio parse                |

#### Implementation Details

**5.1 — Parallel City Job Execution**

_Dedup concurrency-safety (`deduplicator.ts`):_

- `isDuplicateLead()` changed from sync to `async` — now protected by a per-key promise-chain mutex
- `acquireDedupLock(key)` returns a `release()` function; callers `await` the lock and call `release()` in `finally`
- The check-then-add sequence is atomic per key — no TOCTOU race when two city jobs process the same lead simultaneously
- All 27 deduplicator tests updated to `async/await` — all passing

_Parallel controller (`start.ts`):_

- `PARALLEL_CITIES_ENABLED=false` (default) — sequential execution unchanged
- `PARALLEL_CITIES_MAX=2` (default) — max concurrent city jobs, hard cap 4 in code
- When enabled: cities within each batch are split into sub-slices of `PARALLEL_CITIES_MAX` and run via `Promise.allSettled()`
- Visited-city filtering moved before dispatch (shared across parallel and sequential paths)
- `isFirstJob` flag removed — `store.setStatus('running')` called per city in both paths
- Stop condition and maxLeads check preserved in both paths

**5.2 — Worker Process Architecture**

- Skipped. Plan dependency: "persistent/shared storage required before worker-process architecture" for dedup consistency, queue coordination, metrics aggregation, and progress tracking. The in-memory constraint prevents this without a storage layer.

**5.3 — Work Stealing**

- Skipped per plan: "VERY HIGH risk — implement in late Phase 5 only after production-scale validation of execution semantics." SSE ordering, stop conditions, progress tracking, and dedup assumptions all affected.

**5.4 — Streaming Export API (`routes/exportStream.ts`)**

- New route: `GET /api/export/stream`
- Available during `running`, `stopped`, and `completed` status (unlike `/api/export` which blocks during running)
- Returns 204 (no content) when job is running but no leads yet — not an error
- Sets `X-Partial-Results: true` header when job is still running
- Filename: `leads-partial-{timestamp}.xlsx` during running, `leads-{timestamp}.xlsx` when complete
- Uses same sort order, column layout, and streaming threshold as `/api/export`
- Registered in `index.ts` at `/api/export/stream` (before `/api/export` to avoid prefix conflict)

**5.5 — Memory-Optimized HTML Processing (`emailExtractor.ts`, `phoneNormalizer.ts`)**

- `truncateHtmlIfNeeded(html)` exported from `emailExtractor.ts`
- Truncates at last `<` boundary before `HTML_MAX_BYTES` (default 512KB) to avoid mid-tag cuts
- Returns original string unchanged if within limit — zero overhead for normal pages
- Applied in `extractEmail()` before `cheerio.load()` and JSON-LD extraction
- Applied in `extractPhone()` before JSON-LD extraction and text content stripping
- `HTML_MAX_BYTES` configurable via env var
- Expected gain: 50-80% memory reduction for CMS-heavy pages (>512KB HTML)

#### New Environment Variables

| Variable                  | Default  | Description                                          |
| ------------------------- | -------- | ---------------------------------------------------- |
| `PARALLEL_CITIES_ENABLED` | `false`  | Enable parallel city job execution (Phase 5.1)       |
| `PARALLEL_CITIES_MAX`     | `2`      | Max concurrent city jobs, hard cap 4 (Phase 5.1)     |
| `HTML_MAX_BYTES`          | `524288` | Max HTML bytes before truncation — 512KB (Phase 5.5) |

#### Modified Files

- `backend/src/pipeline/deduplicator.ts`
- `backend/src/pipeline/deduplicator.test.ts`
- `backend/src/pipeline/pipeline.ts`
- `backend/src/pipeline/emailExtractor.ts`
- `backend/src/pipeline/phoneNormalizer.ts`
- `backend/src/routes/start.ts`
- `backend/src/routes/exportStream.ts` _(new)_
- `backend/src/index.ts`
- `backend/.env.example`
- `backend/.env`

#### Validation

| Check                                   | Result       |
| --------------------------------------- | ------------ |
| TypeScript compilation (`tsc --noEmit`) | ✅ 0 errors  |
| Full backend test suite                 | ✅ 281/281   |
| No regressions                          | ✅ Confirmed |

#### Deviations from Plan

- 5.2 (Worker Process Architecture) skipped — plan dependency on persistent/shared storage cannot be satisfied under the in-memory constraint.
- 5.3 (Work Stealing) skipped — plan explicitly defers to late Phase 5 after production-scale validation.
- All implemented tasks (5.1, 5.4, 5.5) match plan specifications exactly.

---

### Round-Robin Scheduler — Phase 1: Extract Scheduler + Lock Contract ✅ COMPLETE

| Module                                                           | Status      | Notes                                                                                    |
| ---------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------- |
| `backend/src/pipeline/stateScheduler.ts` — new file              | ✅ Complete | Pure scheduling utility — no Express, SSE, or pipeline deps                              |
| `SchedulerSelection` interface                                   | ✅ Complete | name + rankedCities[]                                                                    |
| `SchedulerConfig` interface                                      | ✅ Complete | selections, batchSize, isVisited callback                                                |
| `ScheduledCity` interface                                        | ✅ Complete | city + selectionName + selectionIndex                                                    |
| `RoundResult` interface                                          | ✅ Complete | cities, roundNumber, newlyExhausted, allExhaustedSelections, allExhausted                |
| `SchedulerSnapshot` interface                                    | ✅ Complete | currentRound, selections[], allExhausted                                                 |
| `SelectionSnapshot` interface                                    | ✅ Complete | name, totalCities, cursor, citiesYielded, exhausted                                      |
| `StateScheduler` interface                                       | ✅ Complete | nextRound(), snapshot(), reset()                                                         |
| `createStateScheduler()` factory                                 | ✅ Complete | Returns StateScheduler instance with internal cursor state                               |
| Lazy visited-city skipping in `collectFromSelection()`           | ✅ Complete | Advances cursor until batchSize valid cities found or exhausted                          |
| Sequential round semantics locked                                | ✅ Complete | Documented in module header — rounds are sequential, parallelism is controller's concern |
| Concurrency rule locked                                          | ✅ Complete | PARALLEL_CITIES_ENABLED only affects inside-round execution                              |
| `CITY_ROUND_ROBIN_ENABLED=false` added to `backend/.env`         | ✅ Complete | Old batching path remains default                                                        |
| `CITY_ROUND_ROBIN_ENABLED=false` added to `backend/.env.example` | ✅ Complete |                                                                                          |
| TypeScript compilation (`tsc --noEmit`)                          | ✅ 0 errors |                                                                                          |

#### Locked Contracts (Phase 1 deliverable)

**Scheduler input shape:**

- `selections[]` — ordered array of `{ name, rankedCities[] }`, one per selected state
- `batchSize` — cities per selection per round (maps to `CITY_BATCH_SIZE`)
- `isVisited(city)` — callback injected by controller; scheduler never calls `isCityVisited()` directly

**Scheduler output shape (per round):**

- `cities[]` — flat ordered list of `ScheduledCity` (selection[0] first, then selection[1], …)
- `roundNumber` — 1-based, increments every call
- `newlyExhausted` — selections that ran out during this round
- `allExhaustedSelections` — all exhausted selections so far
- `allExhausted` — true when every selection is done; controller should break loop

**How `start.ts` asks for the next round:**

```ts
const round = scheduler.nextRound();
if (round.allExhausted) break;
// execute round.cities
```

**How visited-city checking is passed in:**

```ts
isVisited: (city) => isCityVisited(keyword, city.name, isoCountryCode);
```

**How exhaustion is reported:** `round.allExhausted === true` + `round.cities === []`

**How a round is marked complete:** controller awaits all city jobs in `round.cities`, then calls `nextRound()` again

**Round concurrency rule:** rounds are sequential; `PARALLEL_CITIES_ENABLED` only controls concurrency inside a single round

#### Files Changed

- `backend/src/pipeline/stateScheduler.ts` _(new)_
- `backend/.env`
- `backend/.env.example`

#### No Behavior Changes

- `start.ts` unchanged — old flattened batching path still active
- `pipeline.ts` unchanged
- All existing tests pass (281/281)

---

### Round-Robin Scheduler — Phase 2: Add Feature Flag ✅ COMPLETE

| Module                                                               | Status      | Notes                                                |
| -------------------------------------------------------------------- | ----------- | ---------------------------------------------------- |
| `CITY_ROUND_ROBIN_ENABLED` read in `routes/start.ts` config block    | ✅ Complete | `process.env.CITY_ROUND_ROBIN_ENABLED === 'true'`    |
| Module-level comment updated in `start.ts`                           | ✅ Complete | Documents both paths and rollback guarantee          |
| Branch added inside city-batched async controller                    | ✅ Complete | Logs active path on every job start                  |
| Old flattened-batching loop untouched                                | ✅ Complete | Both flag values execute the same loop until Phase 4 |
| `CITY_ROUND_ROBIN_ENABLED=false` already in `.env` (Phase 1)         | ✅ Complete | Old path is default — no behavior change             |
| `CITY_ROUND_ROBIN_ENABLED=false` already in `.env.example` (Phase 1) | ✅ Complete |                                                      |
| TypeScript compilation (`tsc --noEmit`)                              | ✅ 0 errors |                                                      |
| All existing tests passing                                           | ✅ 281/281  | No regressions                                       |

#### What the flag does (Phase 2)

| Flag value        | Behavior                                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `false` (default) | Logs `"Round-robin scheduler DISABLED — using flattened city batching (default)"` → runs existing loop                                  |
| `true`            | Logs `"Round-robin scheduler ENABLED — … (Phase 4 integration pending — running flattened loop as fallback)"` → runs same existing loop |

Both values produce identical execution until Phase 4 wires the scheduler into the `true` branch.

#### Files Changed

- `backend/src/routes/start.ts`

#### No Behavior Changes

- `pipeline.ts` unchanged
- `stateScheduler.ts` unchanged
- All existing tests pass (281/281)

---

### Round-Robin Scheduler — Phase 3: Build and Test Scheduler ✅ COMPLETE

| Module                                                               | Status      | Notes                                                       |
| -------------------------------------------------------------------- | ----------- | ----------------------------------------------------------- |
| `backend/src/pipeline/stateScheduler.test.ts` — new file             | ✅ Complete | 27 tests, all passing                                       |
| Validation tests (batchSize < 1, empty selections, 0-city selection) | ✅ Complete | 3 tests                                                     |
| One selection — count ≤ batchSize                                    | ✅ Complete | Single round, correct exhaustion                            |
| One selection — count > batchSize                                    | ✅ Complete | Multiple rounds, correct pagination                         |
| Many selections — interleaving in selection order                    | ✅ Complete | Cities from sel[0] first, then sel[1], etc.                 |
| Stable ordering — selection order never reordered alphabetically     | ✅ Complete | "Zebra, Apple, Mango" stays in that order                   |
| Uneven selection sizes                                               | ✅ Complete | Small exhausts early; large continues alone                 |
| Exhausted selections skipped in subsequent rounds                    | ✅ Complete | Verified with 3-selection mixed-size scenario               |
| Visited-heavy skipping — lazy cursor advance                         | ✅ Complete | Collects exactly batchSize valid cities, skipping visited   |
| All cities visited — immediate exhaustion                            | ✅ Complete | `isVisited: () => true` → empty round, allExhausted=true    |
| Visited cities across multiple selections                            | ✅ Complete | Each selection's cursor advances independently              |
| Fully exhausted — cursor reaches end                                 | ✅ Complete | `exhausted=true`, cursor=totalCities, citiesYielded correct |
| Empty rounds after all exhausted                                     | ✅ Complete | Safe to call nextRound() repeatedly after exhaustion        |
| Partially exhausted — allExhaustedSelections tracking                | ✅ Complete | Accumulates correctly across rounds                         |
| Sequential rounds — roundNumber increments every call                | ✅ Complete | Including empty post-exhaustion rounds                      |
| No overlapping cities across rounds                                  | ✅ Complete | Set-based uniqueness check across all rounds                |
| City order within selection preserved                                | ✅ Complete | Ranked order never shuffled                                 |
| Selection order preserved across rounds                              | ✅ Complete | Same order in every round                                   |
| Stop-safe iteration                                                  | ✅ Complete | Scheduler state preserved when controller breaks early      |
| snapshot() — non-advancing state read                                | ✅ Complete | cursor, citiesYielded, exhausted, currentRound all correct  |
| reset() — full state reset for test isolation                        | ✅ Complete | Cursors, counters, exhaustion all reset                     |
| selectionIndex annotation                                            | ✅ Complete | 0-based index on every ScheduledCity                        |
| Edge: batchSize > total cities                                       | ✅ Complete | Returns all cities in one round                             |
| Edge: batchSize = 1                                                  | ✅ Complete | One city per selection per round                            |
| Edge: single city in single selection                                | ✅ Complete | One round, one city, immediately exhausted                  |
| Edge: visited cities causing early exhaustion                        | ✅ Complete | Fewer than batchSize returned when list runs out mid-skip   |

#### Test isolation

- No Express, SSE, pipeline, or store involvement in any test
- `isVisited` is a plain callback — no `isCityVisited()` import
- `mockCity()` / `mockCities()` helpers produce minimal `CityEntry` objects
- All tests are synchronous — no async, no timers, no teardown needed

#### Validation

| Check                            | Result       |
| -------------------------------- | ------------ |
| stateScheduler tests             | ✅ 27/27     |
| Full backend test suite          | ✅ 308/308   |
| No regressions in existing tests | ✅ Confirmed |

#### Files Changed

- `backend/src/pipeline/stateScheduler.test.ts` _(new)_

---

### Round-Robin Scheduler — Phase 4: Integrate into Controller ✅ COMPLETE

| Module                                                                  | Status      | Notes                                                                   |
| ----------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------- |
| `backend/src/routes/start.ts` — scheduler integration                   | ✅ Complete | Two execution paths: round-robin (new) + flattened (old)                |
| Import `createStateScheduler` from `stateScheduler.ts`                  | ✅ Complete |                                                                         |
| Build per-state city lists (`perStateCities`)                           | ✅ Complete | Used by both paths — round-robin keeps separate, flattened concatenates |
| Shared helper: `dispatchCity(city, batchNum)`                           | ✅ Complete | Runs `runPipeline()`, marks visited, increments counter                 |
| Shared helper: `runCitySlice(cities[], batchNum)`                       | ✅ Complete | Handles sequential vs parallel execution inside a round/batch           |
| **PATH A — Round-robin scheduler** (`CITY_ROUND_ROBIN_ENABLED=true`)    | ✅ Complete | Full integration with `createStateScheduler()`                          |
| Scheduler config: `selections`, `batchSize`, `isVisited` callback       | ✅ Complete | `isVisited` injected — scheduler never calls `isCityVisited` directly   |
| Round loop — strictly sequential                                        | ✅ Complete | Round N+1 never starts before all Round N jobs complete                 |
| `round.allExhausted` → break loop                                       | ✅ Complete | Stops when every selection is exhausted                                 |
| `round.cities.length === 0` → skip round (all visited)                  | ✅ Complete | Advances to next round without dispatching                              |
| `round.newlyExhausted` logging                                          | ✅ Complete | Logs which selections ran out during this round                         |
| `PARALLEL_CITIES_ENABLED` respected inside rounds                       | ✅ Complete | Concurrency only within `runCitySlice()`, never across rounds           |
| **PATH B — Flattened batching** (`CITY_ROUND_ROBIN_ENABLED=false`)      | ✅ Complete | Original behaviour completely untouched                                 |
| Flatten `perStateCities` into `fullCityList`                            | ✅ Complete | Concatenates all per-state arrays                                       |
| Fixed-slice batching with `batchPointer`                                | ✅ Complete | Original loop preserved exactly                                         |
| Visited-city filtering before dispatch                                  | ✅ Complete | Same as before — `isCityVisited()` called per city                      |
| **Shared final-status block**                                           | ✅ Complete | Both paths converge to same completion logic                            |
| `citiesProcessed` / `totalCities` for SSE `batchProgress`               | ✅ Complete | Works correctly in both paths                                           |
| `currentBatch` → `roundNumber` (round-robin) or slice index (flattened) | ✅ Complete | SSE display compatible with both                                        |
| `runPipeline()` unchanged                                               | ✅ Complete | No pipeline.ts changes                                                  |
| SSE schema unchanged                                                    | ✅ Complete | No new fields emitted yet (Phase 6)                                     |
| Dedup, exports, store, scraper — all untouched                          | ✅ Complete |                                                                         |
| Scheduler metadata stays internal                                       | ✅ Complete | `round.newlyExhausted`, `round.allExhaustedSelections` logged only      |

#### Key design decisions

- **Per-state city lists built once** — both paths use `perStateCities`, avoiding duplicate `getFullRankedCities()` calls
- **Shared helpers** — `dispatchCity()` and `runCitySlice()` eliminate code duplication between paths
- **Sequential rounds enforced** — round loop uses `await runCitySlice()` before calling `scheduler.nextRound()` again
- **Lazy visited-city skipping** — round-robin path relies on scheduler's `isVisited` callback; flattened path filters before dispatch (original behaviour)
- **Stop conditions preserved** — both paths check `stopSignal.stopped` and `store.getLeadCount() >= maxLeads` before every dispatch
- **SSE `batchProgress` compatible** — `currentBatch` and `totalBatches` work for both paths (round number vs slice index)

#### Validation

| Check                                   | Result       |
| --------------------------------------- | ------------ |
| TypeScript compilation (`tsc --noEmit`) | ✅ 0 errors  |
| Full backend test suite                 | ✅ 308/308   |
| No regressions in existing tests        | ✅ Confirmed |

#### Files Changed

- `backend/src/routes/start.ts`

#### No Behavior Changes (flag=false)

- `CITY_ROUND_ROBIN_ENABLED=false` (default) → flattened path executes exactly as before
- All 308 tests pass — no regressions
- `pipeline.ts`, `stateScheduler.ts`, `visitedCities.ts`, SSE schema, store, dedup, exports — all untouched

---

### Round-Robin Scheduler — Phase 6: Atomic SSE + Frontend Update ✅ COMPLETE

Deployed backend SSE payload changes and frontend rendering together as one atomic update.

#### Backend changes

| Module                                                                         | Status      | Notes                                                              |
| ------------------------------------------------------------------------------ | ----------- | ------------------------------------------------------------------ |
| `backend/src/types.ts` — `SseStatusPayload.roundRobinProgress` added           | ✅ Complete | Optional field — only present when `CITY_ROUND_ROBIN_ENABLED=true` |
| `roundRobinProgress.currentRound` — 1-based round number                       | ✅ Complete |                                                                    |
| `roundRobinProgress.selections[]` — per-selection progress array               | ✅ Complete | name, citiesYielded, totalCities, exhausted                        |
| `backend/src/routes/start.ts` — `finalRRProgress` variable added               | ✅ Complete | Captures final scheduler snapshot for terminal status emit         |
| `runCitySlice()` — accepts optional `roundRobinProgress` param                 | ✅ Complete | Passed through to `emitStatus()` on every round start              |
| PATH A round loop — builds `rrProgress` from `scheduler.snapshot()` each round | ✅ Complete | Emitted before cities are dispatched                               |
| PATH A end — captures `finalRRProgress` from `scheduler.snapshot()`            | ✅ Complete | Included in terminal `completed`/`stopped` status emit             |
| PATH B — `roundRobinProgress` stays `undefined` (field absent from SSE)        | ✅ Complete | No change to flattened path behaviour                              |
| Module header comment updated to reflect Phase 6 completion                    | ✅ Complete |                                                                    |

#### Frontend changes

| Module                                                                               | Status      | Notes                                               |
| ------------------------------------------------------------------------------------ | ----------- | --------------------------------------------------- |
| `frontend/src/types.ts` — `StatusPayload.roundRobinProgress` added                   | ✅ Complete | Mirrors backend shape exactly                       |
| `frontend/src/app/page.tsx` — `roundRobinProgress` state added                       | ✅ Complete | Reset to `undefined` on new job start               |
| `frontend/src/app/page.tsx` — `handleStatus` reads `roundRobinProgress`              | ✅ Complete | Updates state when field is present in SSE payload  |
| `frontend/src/app/page.tsx` — passes `roundRobinProgress` to `StatusBar`             | ✅ Complete |                                                     |
| `frontend/src/components/StatusBar.tsx` — `roundRobinProgress` prop added            | ✅ Complete |                                                     |
| `StatusBar` — per-selection progress bars rendered when `roundRobinProgress` present | ✅ Complete | Only shown during `running` state                   |
| Per-selection bar: name, citiesYielded/totalCities, exhausted ✓ indicator            | ✅ Complete | Exhausted selections shown with muted bar + ✓ badge |
| Accessibility: `role="progressbar"`, `aria-valuenow/min/max` on each bar             | ✅ Complete |                                                     |

#### SSE payload shape (round-robin path only)

```json
{
  "status": "running",
  "leadCount": 12,
  "discardCount": 3,
  "activeKeyword": "lawyer",
  "activeLocation": "Ahmedabad, Surat",
  "batchProgress": {
    "currentBatch": 2,
    "totalBatches": 62,
    "citiesProcessed": 5,
    "totalCities": 311
  },
  "roundRobinProgress": {
    "currentRound": 2,
    "selections": [
      {
        "name": "Gujarat",
        "citiesYielded": 10,
        "totalCities": 311,
        "exhausted": false
      },
      {
        "name": "Rajasthan",
        "citiesYielded": 10,
        "totalCities": 182,
        "exhausted": false
      }
    ]
  }
}
```

#### Validation

| Check                                | Result       |
| ------------------------------------ | ------------ |
| Backend TypeScript (`tsc --noEmit`)  | ✅ 0 errors  |
| Frontend TypeScript (`tsc --noEmit`) | ✅ 0 errors  |
| Full backend test suite              | ✅ 308/308   |
| No regressions                       | ✅ Confirmed |

#### Files Changed

- `backend/src/types.ts`
- `backend/src/routes/start.ts`
- `frontend/src/types.ts`
- `frontend/src/app/page.tsx`
- `frontend/src/components/StatusBar.tsx`

---

### Round-Robin Scheduler — Phase 7: Full Regression Testing ✅ COMPLETE

#### Bug found and fixed during testing

**Bug:** Round-robin path skipped the last round's cities when all selections exhausted in the same round they produced cities.

**Root cause:** The round loop checked `if (round.allExhausted) break` BEFORE dispatching cities. When a selection's last cities were collected in round N, `allExhausted` was `true` but `cities` was non-empty. The break fired before `runCitySlice` was called.

**Fix:** Changed the break condition to `if (round.allExhausted && round.cities.length === 0) break` at the top of the loop. Added a second `if (round.allExhausted) break` AFTER `runCitySlice` to stop the loop once the last cities are dispatched.

**Also fixed:** `roundRobinProgress` was missing from the final status `emitStatus` call (lost during a previous edit). Restored.

**Also fixed:** `start.ts` config constants (`CITY_BATCH_SIZE`, `CITY_ROUND_ROBIN_ENABLED`, etc.) were module-level, preventing test env overrides from taking effect. Moved to per-request reads inside the route handler.

**Also fixed:** Dynamic imports for `getFullRankedCities` and `emitStatus`/`closeSSEConnection` inside the async IIFE prevented Jest mocks from intercepting them. Converted to static imports.

#### Test file: `backend/src/routes/start.regression.test.ts` (34 tests)

| Suite                          | Tests | Description                                         |
| ------------------------------ | ----- | --------------------------------------------------- |
| PATH B — Flattened batching    | 11    | Original behaviour regression tests                 |
| PATH A — Round-robin scheduler | 12    | New scheduler behaviour tests                       |
| Feature flag switching         | 2     | Both paths produce correct dispatch order           |
| SSE stability                  | 3     | Terminal status, batchProgress, no duplicate closes |
| Input validation               | 6     | Shared validation (both paths)                      |

#### Scenarios covered

| Scenario                                       | PATH B | PATH A |
| ---------------------------------------------- | ------ | ------ |
| City dispatch order                            | ✅     | ✅     |
| Selection order preserved (not alphabetical)   | —      | ✅     |
| Stop mid-batch / mid-round                     | ✅     | ✅     |
| maxLeads mid-batch / mid-round                 | ✅     | ✅     |
| Visited-heavy queues                           | ✅     | ✅     |
| All-visited queue (no dispatches)              | —      | ✅     |
| Exhausted selections skipped                   | —      | ✅     |
| Many selections (5 states)                     | —      | ✅     |
| Sequential mode                                | ✅     | ✅     |
| Parallel mode                                  | ✅     | ✅     |
| SSE batchProgress present                      | ✅     | ✅     |
| roundRobinProgress absent in flattened path    | ✅     | —      |
| roundRobinProgress present in round-robin path | —      | ✅     |
| Final status includes roundRobinProgress       | —      | ✅     |
| markCityVisited called after each job          | ✅     | ✅     |
| Empty city pool handled gracefully             | ✅     | —      |
| Feature flag switching                         | ✅     | ✅     |
| No duplicate closeSSEConnection                | ✅     | ✅     |
| Input validation (6 cases)                     | ✅     | ✅     |

#### Validation

| Check                                   | Result       |
| --------------------------------------- | ------------ |
| Regression test suite                   | ✅ 34/34     |
| Full backend test suite                 | ✅ 342/342   |
| TypeScript compilation (`tsc --noEmit`) | ✅ 0 errors  |
| No regressions in existing tests        | ✅ Confirmed |

#### Files Changed

- `backend/src/routes/start.regression.test.ts` _(new — 34 tests)_
- `backend/src/routes/start.ts` — 3 bug fixes:
  - Round loop exhaustion check (dispatch last cities before breaking)
  - `roundRobinProgress` restored in final status emit
  - Config constants moved to per-request reads
  - Dynamic imports converted to static imports
