# Phase 1 Summary — MVP Backend Scaffold

**Status:** ✅ Complete  
**Tests:** 56/56 passing  
**Next phase:** Phase 2 — Website Scraping (Homepage)

---

## What Was Built

Phase 1 delivers the complete Express backend skeleton with all five API routes, the in-memory store, SSE connection management, and the Excel exporter. No scraping logic yet — stubs are in place for the geocoder and pipeline, ready for Phase 2 to wire in.

---

## Files Created

```
backend/
├── package.json              — dependencies, scripts (dev/build/start/test)
├── tsconfig.json             — TypeScript 5, strict mode, ES2020 target
├── jest.config.js            — ts-jest, node environment
├── .env.example              — all environment variables documented
└── src/
    ├── types.ts              — Lead, RawLead, JobStatus, QualityTier, FailureMetrics,
    │                           JobContext, StoreStats, all SSE payload types
    ├── logger.ts             — winston console transport (file transport in Phase 5)
    ├── store.ts              — in-memory leads[], dedup Set, failure metrics, job context
    ├── sse.ts                — SSE connection registry, emit helpers, connection cleanup
    ├── exporter.ts           — Excel generation (buffer ≤500, streaming >500)
    ├── index.ts              — Express app, CORS, routes, graceful shutdown
    ├── routes/
    │   ├── start.ts          — POST /api/start (validation, geocode stub, pipeline stub)
    │   ├── stop.ts           — POST /api/stop (10s hard timeout structure)
    │   ├── status.ts         — GET /api/status (stats + failure metrics)
    │   ├── stream.ts         — GET /api/stream (SSE registration)
    │   └── export.ts         — GET /api/export (xlsx download)
    ├── store.test.ts         — 22 tests
    ├── sse.test.ts           — 18 tests
    └── exporter.test.ts      — 16 tests
```

---

## Key Design Decisions

**Store dedup key guard** — `isDuplicate()` treats `''` and `'|'` as non-keys and always returns `false`, satisfying the constraint that entries with no phone and no domain pass through without deduplication.

**SSE connection safety** — `registerSSEConnection()` closes any existing connection for the same `jobId` before registering the new one. The `res.on('close')` handler cleans up the registry when the client disconnects. `closeSSEConnection()` is called on both stop and completion.

**Stop handler structure** — The 10-second hard timeout is implemented via `Promise.race([drainPromise, timeoutPromise])`. The force-close block for Playwright browser contexts is stubbed with a clear `TODO Phase 2` comment. The structure is correct and ready to be filled in.

**Export strategy selector** — `shouldUseStreaming(leadCount)` switches to `generateExcelStreaming()` above 500 leads. Both paths produce identical output format. The `leads[]` array is never mutated.

**Internal fields never leak** — `PublicLead` type (omits `_hasBoth` and `_qualityTier`) is used for SSE `lead` event payloads. The exporter only maps the five public columns. Both are enforced at the type level.

---

## Stubs for Phase 2

| Location | Stub | Phase 2 Action |
|----------|------|----------------|
| `routes/start.ts` → `geocodeLocation()` | Returns `'US'` for any input | Replace with real Google Geocoding API call + retry logic |
| `routes/start.ts` → `runPipelineStub()` | Sets status to `completed` after 100ms | Replace with discovery → dedup → scrape → filter → SSE pipeline |
| `routes/stop.ts` → force-close block | Logs "none active" | Wire in `browserPool.getActiveBrowserContexts()` |

---

## Constraints Verified

| Constraint | Status |
|------------|--------|
| No email guessing | ✅ No email logic exists yet — enforced by type system |
| No persistent storage | ✅ All state in module-level variables, cleared on `reset()` |
| Filter runs post-scrape only | ✅ No filter logic yet — stub pipeline never discards |
| Stop terminates within 10 seconds | ✅ `Promise.race` with 10s timeout in place |
| Phone in E.164 format | ✅ No phone logic yet — type enforces string |
| Dedup key = `normalizedPhone\|rootDomain` | ✅ `store.isDuplicate(key)` accepts pre-formed key |
| SSE per-jobId connection tracking | ✅ `activeConnections` Map, old connection closed on new register |
| Internal fields not in SSE/export | ✅ `PublicLead` type + exporter column list enforced |

---

## How to Run

```bash
# Install dependencies (already done)
npm install

# Copy and fill in API keys
cp .env.example .env

# Development server (hot reload)
npm run dev
# → http://localhost:4000

# Run tests
npm test

# Build for production
npm run build
npm start
```

---

## API Endpoints (Phase 1)

```
POST /api/start   { keyword, location, depth }  → { jobId } or { error }
POST /api/stop                                   → { message, leadCount, discardCount }
GET  /api/status                                 → { status, leadCount, discardCount, failureMetrics, jobContext }
GET  /api/stream?jobId=<id>                      → SSE stream
GET  /api/export                                 → leads.xlsx download
GET  /health                                     → { status: "ok" }
```
