# Project Understanding

## What This Project Is

This repository is a lead-generation scraper with:

- A `frontend/` Next.js dashboard for operators
- A `backend/` Express + TypeScript API that runs scrape jobs
- A live SSE stream for incremental results
- An in-memory store only, with Excel export at the end

The current implementation is no longer just a simple "keyword + one location" scraper. It now supports:

- `country + states[]` driven city-batched runs
- Optional Serper-assisted discovery with Google Maps fallback
- Per-city pipeline execution
- Stop/resume-safe partial export behavior
- Several performance and reliability feature flags

## How I Built This Understanding

I used two sources together:

1. `graphify-out/GRAPH_REPORT.md`
2. The current code in `backend/src/` and `frontend/src/`

I also read project markdown docs in `docs/` and the large blueprint in the repo root. Those markdown files are useful for intent and history, but several of them are now partially outdated. The current code is the source of truth.

## Graphify View of the Codebase

`graphify-out/GRAPH_REPORT.md` shows the project is organized around a few dominant abstractions:

- `discoverLeads()` is the biggest hub for finding raw businesses
- `runPipeline()` is the main single-city execution orchestrator
- `createStealthBrowser()` underpins both discovery and website scraping
- `processLead()` is where extracted data becomes an accepted or discarded lead
- `emitStatus()` and the SSE layer connect backend progress to the UI
- `BrowserContextPool`, `searchSerper()`, and `isDuplicateLead()` are major support systems

The report’s communities line up well with the actual modules:

- Discovery and Maps/Serper logic
- Pipeline/job orchestration
- SSE and event emission
- Browser anti-blocking
- Deduplication and rolling windows
- City pool and scheduler logic
- Export generation
- Email/phone extraction

That graph structure matches the real runtime flow described below.

## High-Level Architecture

### Frontend

The frontend is a small Next.js app centered around `frontend/src/app/page.tsx`.

It lets the operator:

- Enter one keyword
- Choose a country
- Select one or more states/regions
- Set `maxLeads`
- Choose scrape depth: `homepage` or `indepth`
- Choose contact filter: `any`, `email_only`, `phone_only`, `both`
- Toggle discovery source preference: Serper vs Google Maps

Main frontend pieces:

- `frontend/src/app/page.tsx`: page-level state and API calls
- `frontend/src/hooks/useSSE.ts`: opens `/api/stream?jobId=...`
- `frontend/src/components/InputPanel.tsx`: job configuration form
- `frontend/src/components/StatusBar.tsx`: live status, batch progress, round-robin progress
- `frontend/src/components/ResultsTable.tsx`: recent live results table
- `frontend/src/components/ExportButton.tsx`: final export trigger

### Backend

The backend is an Express service started from `backend/src/index.ts`.

It exposes:

- `POST /api/start`
- `POST /api/stop`
- `GET /api/status`
- `GET /api/stream`
- `GET /api/export`
- `GET /api/export/stream`
- `GET /api/locations/countries`
- `GET /api/locations/states`

Core backend layers:

- Route/controller layer in `backend/src/routes/`
- Job/session state in `backend/src/store.ts`
- SSE connection management in `backend/src/sse.ts`
- Single-city pipeline in `backend/src/pipeline/pipeline.ts`
- Discovery, scraping, extraction, dedup, location, and scheduling modules in `backend/src/pipeline/`
- Excel export in `backend/src/exporter.ts`

## The Real Runtime Flow

## 1. A job starts in `POST /api/start`

`backend/src/routes/start.ts` is the true top-level orchestrator.

It:

- Rejects new jobs if one is already running
- Validates the incoming request
- Resets the in-memory store
- Applies the per-job `SERPER_ENABLED` override
- Chooses one of two modes:
  - `city_batched`
  - `legacy`

### Current primary mode: `city_batched`

This is the more important modern path.

Input shape:

- `keyword`
- `country`
- `states[]`
- `maxLeads`
- `depth`
- `contactFilter`
- `useSerper`

`start.ts` resolves the country ISO code using `cityPool.ts`, initializes the job context, and then owns the full multi-city orchestration itself.

Important design point:

- `start.ts` owns batching, city iteration, stop conditions, and final completion
- `pipeline.ts` only runs one city job at a time

### Legacy mode

Legacy mode still exists for direct `location` string input.

It geocodes each location using `geocoder.ts`, then calls `runPipeline()` per location. This is backward-compatible behavior, but the newer country/state workflow is clearly the main architecture now.

## 2. City expansion happens before scraping

`backend/src/pipeline/cityPool.ts` is a major subsystem.

It builds ranked city lists from static data:

- `country-state-city` package for countries/states/cities
- GeoNames data files for population ranking
- Admin1 mapping files for region bridging

This means the system does not discover cities dynamically at runtime for the modern path. Instead it:

- Resolves a country
- Resolves/fuzzy-matches selected states
- Expands each state into a ranked city list
- Processes those cities in order

Important behavior:

- Largest cities are prioritized first
- Fuzzy state matching exists
- Region bridging exists for countries where admin/state naming differs
- Cities are static-data driven, not fetched from an API during the run

## 3. Scheduling is controller-driven

There are two city execution strategies in `start.ts`:

- Flattened batching
- Round-robin scheduling

Round-robin uses `backend/src/pipeline/stateScheduler.ts`.

That scheduler is intentionally pure:

- No Express dependency
- No SSE dependency
- No store mutations
- No direct pipeline calls

It only returns the next round of cities. `start.ts` still decides how to execute them.

This is a clean separation:

- `stateScheduler.ts` decides *which cities come next*
- `start.ts` decides *what to do with them*

## 4. `runPipeline()` processes exactly one city/job slice

`backend/src/pipeline/pipeline.ts` is the single-city engine.

Its real execution flow is:

1. Emit running status
2. Discover raw leads
3. Deduplicate raw leads
4. Scrape business websites
5. Extract email and phone
6. Filter and finalize leads
7. Emit live SSE events
8. Finish with `completed`, `stopped`, or `error`

Important boundaries:

- It does not own country/state batching
- It does not own city scheduling
- It does not own export
- It does not persist anything

It is deliberately a reusable "process one location slice" engine.

## 5. Discovery is hybrid: Serper first, Maps fallback

`backend/src/pipeline/discovery.ts` is one of the most important files.

Current behavior:

- If `SERPER_ENABLED=true`, it tries Serper first
- If Serper returns enough useful results, those are converted into `RawLead[]`
- Otherwise it falls back to Google Maps scraping via Playwright

### Serper path

`backend/src/pipeline/serper.ts` handles:

- Query execution
- Timeout handling
- Concurrency limiting
- In-memory query caching
- Response normalization
- Result validation
- Conversion into the project’s `RawLead` shape

Serper is only for discovery, not for trustworthy final contact enrichment.

### Google Maps path

If Serper is disabled or insufficient, `discovery.ts`:

- Launches a stealth browser
- Navigates to Google Maps search URLs
- Detects consent dialogs and CAPTCHA pages
- Finds the results feed with selector fallbacks
- Scrolls until the feed stabilizes or a cap is hit
- Extracts name/address/phone/website from list items
- Falls back to detail-panel navigation only when needed

Discovery intentionally does **not** filter leads. It returns raw candidates.

## 6. Dedup happens before website scraping

`backend/src/pipeline/deduplicator.ts` has two layers:

- Per-run dedup via `store.ts`
- Cross-run rolling window dedup in module memory

Key format:

- `rawPhone|rootDomain`

Behavior:

- Duplicate raw leads are removed before costly scraping starts
- Rolling window survives `store.reset()` but not process restarts
- Per-key locks exist to avoid races when city execution is parallelized

There is a second rolling-memory system in `visitedCities.ts` that tracks:

- `keyword + city + country`

This is separate from raw lead dedup. It prevents re-scraping the same city for the same keyword inside the window.

## 7. Website scraping is optimized and defensive

`backend/src/pipeline/scraper.ts` decides how to fetch each website.

It has several protections:

- `robots.txt` compliance check via `robots.ts`
- DNS pre-resolution
- Circuit breaker per domain
- Retries with backoff for retryable failures
- Browser context pooling behind a feature flag

### Static vs dynamic detection

Before always using Playwright, `detect.ts` tries to classify a site:

- Static pages can use a cheap fetch/Cheerio path
- Dynamic pages fall back to Playwright

This reduces browser usage on simpler sites.

### In-depth mode

If depth is `indepth`, `indepth.ts`:

- Scrapes homepage first
- Extracts likely contact/about/team links
- Follows a limited number of same-domain subpages
- Merges HTML into one combined extraction surface

This module still does not do filtering. It only returns richer HTML.

## 8. Contact extraction is conservative

### Email extraction

`backend/src/pipeline/emailExtractor.ts` is intentionally strict.

It:

- Reads JSON-LD first
- Looks at `mailto:` links
- Scans visible body text with regex
- Deduplicates
- Applies blacklist/noise filtering
- Optionally validates domain MX presence
- Prefers company-domain emails over freemail fallbacks
- Applies bounce-risk classification rules

Important invariant:

- Emails are scraped only from actual page content
- The system does not invent or guess emails

### Phone extraction

`backend/src/pipeline/phoneNormalizer.ts`:

- Tries the discovery-phase phone first
- Falls back to JSON-LD phone
- Falls back again to page text scanning
- Normalizes with `libphonenumber-js`
- Stores only E.164 values

This makes phone handling stricter than raw discovery data.

## 9. `processLead()` is the acceptance gate

`backend/src/pipeline/filter.ts` is where a raw scraped business becomes:

- an accepted lead, or
- a discard

It:

- Applies the operator’s contact filter
- Increments discard metrics when needed
- Assigns internal quality tiers
- Detects contact forms
- Adds bounce-risk flags
- Writes accepted leads to the store
- Emits either `lead` or `discard` SSE events

This is the boundary between "extracted data" and "business result".

## 10. State is all in memory

`backend/src/store.ts` is the session store.

It keeps:

- `leads[]`
- discard count
- job status
- current job context
- per-run dedup set
- failure metrics

This project does not use a database.

Consequences:

- Restarting the backend loses job data
- Starting a new job clears previous results
- Export must happen before process shutdown if the user needs the data later

## 11. SSE is the live integration layer

`backend/src/sse.ts` and `backend/src/routes/stream.ts` are the real-time backbone.

They provide:

- One active SSE connection per `jobId`
- Keepalive pings
- `lead`, `discard`, `status`, and `error` events
- Automatic closure on terminal states

The frontend hook `useSSE.ts` listens for these events and updates page state incrementally.

This is why the UI can show:

- live lead accumulation
- discard counts
- active location/keyword
- batch progress
- round-robin progress

without polling.

## 12. Export is generated from memory, not from the UI

`backend/src/exporter.ts` and the export routes generate `.xlsx` files from the backend store.

There are two routes:

- `/api/export`: final export, only after stop/completion
- `/api/export/stream`: partial export, even while running

Export behavior:

- Leads are sorted so strongest leads appear first
- Rows are styled
- Website hyperlinks are preserved
- Large exports can stream instead of buffering

The frontend table display limit does not affect export. The UI may show only recent rows for performance, but export uses the full backend store.

## The Most Important Modules

If someone new joins the project, these are the best files to read first:

- `backend/src/routes/start.ts`
- `backend/src/pipeline/pipeline.ts`
- `backend/src/pipeline/discovery.ts`
- `backend/src/pipeline/scraper.ts`
- `backend/src/pipeline/filter.ts`
- `backend/src/store.ts`
- `backend/src/sse.ts`
- `frontend/src/app/page.tsx`
- `frontend/src/hooks/useSSE.ts`

That set explains most of the runtime behavior.

## Current Design Rules and Invariants

The code currently enforces these ideas consistently:

- The frontend is thin; the backend owns job execution
- `start.ts` owns multi-city orchestration
- `pipeline.ts` owns one city/location run
- Discovery is separate from enrichment
- Filtering happens after scraping/extraction, not during discovery
- SSE is the live transport between backend and UI
- Session state is in-memory only
- Export is derived from backend memory, not reconstructed from UI state

## Where The Docs Drift From The Code

Some markdown files reflect older project phases and should be treated as historical:

- The root blueprint still describes older discovery assumptions and architecture ideas that are no longer fully true
- `docs/CONSTRAINTS.md` includes rules that no longer match the current implementation, such as pure Maps-only discovery and single-location-only scope

What is now true in code:

- Serper integration exists
- Country/state city-batched execution exists
- Round-robin scheduling exists
- Partial export exists
- More fields are exported than the older docs originally promised

So for implementation questions, prefer:

1. Current code
2. `graphify-out/GRAPH_REPORT.md`
3. Newer phase docs
4. Older blueprint/constraints docs only as historical context

## Practical Mental Model

The easiest way to think about the project is:

- The operator configures a regional scrape job in the frontend
- `start.ts` expands that job into many city-level runs
- `pipeline.ts` processes one city at a time
- `discovery.ts` finds candidate businesses
- dedup + scraper + extractors enrich them
- `filter.ts` decides which businesses qualify
- `store.ts` keeps accepted leads in memory
- `sse.ts` streams progress and results back live
- `exporter.ts` turns the final in-memory dataset into Excel

That is the current working architecture of the project.
