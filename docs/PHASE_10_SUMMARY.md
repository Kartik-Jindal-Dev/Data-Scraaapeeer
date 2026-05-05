# Phase 10 Summary — Compliance & Operations

**Status:** ✅ Complete  
**Tests:** 233/233 passing (14 new + 219 from Phases 1–9)  
**All 10 phases complete.**

---

## What Was Implemented

Phase 10 adds the three operational pillars: structured file logging, rate limiting on job starts, and robots.txt compliance. A full operational runbook was also created.

---

## Files Created / Modified

```
backend/src/
├── logger.ts                      — UPDATED: file transport added (logs/app.log)
├── index.ts                       — UPDATED: trust proxy for correct IP detection
├── middleware/
│   └── rateLimiter.ts             — NEW: express-rate-limit, 5 req/min/IP
├── routes/
│   └── start.ts                   — UPDATED: rate limiter wired in
└── pipeline/
    ├── robots.ts                  — NEW: robots.txt checker (fail-open, cached)
    ├── robots.test.ts             — NEW: 14 tests
    └── scraper.ts                 — UPDATED: robots check before scrapePage()

backend/
└── .env.example                   — UPDATED: RESPECT_ROBOTS_TXT documented

docs/
└── RUNBOOK.md                     — NEW: operational runbook
```

---

## Feature Details

### 1. File Logging (Winston)

```
logs/app.log
```

- Format: `YYYY-MM-DD HH:mm:ss [LEVEL] message`
- Rotation: 10 MB max per file, 5 files kept (`app.log`, `app.log.1`, ..., `app.log.5`)
- Path: controlled by `LOG_FILE` env variable (default: `./logs/app.log`)
- Directory created automatically by Winston on first write
- Console transport unchanged (colourised, HH:mm:ss format)

What gets logged:
- Pipeline start/stop with keyword, location, depth, jobId
- Each lead found (name, email present, phone present)
- Each discard (name, reason)
- Scraping errors (website unreachable, CAPTCHA, timeout)
- Geocode success/failure
- Anti-blocking: browser launch details (UA, viewport, proxy)
- robots.txt disallowed URLs

### 2. Rate Limiting (`express-rate-limit`)

Applied to `POST /api/start` only. Other endpoints are unaffected.

| Setting | Value |
|---------|-------|
| Window | 60 seconds |
| Max requests | 5 per IP |
| Headers | `RateLimit-*` (RFC standard) |
| Response on limit | `429 { error: "rate_limit_exceeded", message: "..." }` |
| IP detection | `X-Forwarded-For` (first hop) when behind proxy |

`app.set('trust proxy', 1)` added to `index.ts` so the rate limiter uses the real client IP when behind nginx.

### 3. Robots.txt Compliance

Controlled by `RESPECT_ROBOTS_TXT=true` (default).

**Behaviour:**
- Fetches `<origin>/robots.txt` once per domain per process lifetime (in-memory cache)
- Checks the URL path against `User-agent: *` and `User-agent: Googlebot` rules
- `Allow` takes precedence over `Disallow` for the same path (longest match wins)
- **Fail-open**: if robots.txt cannot be fetched (404, timeout, network error), scraping proceeds
- Disallowed URLs are treated as unreachable — `website_unreachable` metric incremented, lead may still qualify via discovery phone
- Does NOT block the pipeline — one disallowed site does not stop other leads

**To disable:**
```env
RESPECT_ROBOTS_TXT=false
```

### 4. Operational Runbook (`docs/RUNBOOK.md`)

Covers:
- How to start the system (local dev + VPS/pm2)
- How to run a job step-by-step
- How to debug failures (log patterns, common issues table)
- How to stop safely (UI, API, pm2)
- All environment variables with defaults and descriptions
- Known limitations
- Log file management
- nginx configuration for SSE

---

## Test Coverage

| Test | Result |
|------|--------|
| `isAllowedByRobots()` → true when RESPECT_ROBOTS_TXT not set | ✅ |
| `isAllowedByRobots()` → true when RESPECT_ROBOTS_TXT = "false" | ✅ |
| `isAllowedByRobots()` → true for empty robots.txt | ✅ |
| `isAllowedByRobots()` → true for 404 robots.txt | ✅ |
| `isAllowedByRobots()` → true on fetch error (fail-open) | ✅ |
| `isAllowedByRobots()` → true when path not mentioned | ✅ |
| `isAllowedByRobots()` → false when path disallowed by wildcard | ✅ |
| `isAllowedByRobots()` → false when root disallowed | ✅ |
| Allow rule takes precedence over Disallow | ✅ |
| Explicitly allowed path returns true | ✅ |
| Cache: same domain fetched only once | ✅ |
| Cache: different domains fetched separately | ✅ |
| `clearRobotsCache()` causes re-fetch | ✅ |
| Malformed URL → true (fail-open) | ✅ |

---

## Final Test Summary (All Phases)

| Phase | Tests | Key Modules |
|-------|-------|-------------|
| 1 | 56 | store, sse, exporter |
| 2 | 34 | geocoder, deduplicator |
| 3 | 30 | detect, scraper |
| 4 | 47 | emailExtractor, phoneNormalizer |
| 5 | 22 | filter |
| 6 | 0 | frontend (TypeScript check only) |
| 7 | 0 | exporter (already covered in Phase 1) |
| 8 | 11 | indepth |
| 9 | 19 | antiBlocking |
| 10 | 14 | robots |
| **Total** | **233** | **13 test suites** |
