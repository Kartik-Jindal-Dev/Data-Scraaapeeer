# Potential Upgrades & Improvements

> This document catalogs ideas for improving the Lead Generation Scraper beyond its current
> implementation. All items are segregated by cost tier: **Free**, **Freemium**, and **Paid**.
> New sections cover increasing result volume, architectural improvements, and scalability.
> None of these are required — the system is fully functional as-is.
>
> **✅ All FREE upgrades from `docs/FREE_UPGRADES_PLAN.md` have been implemented (May 2026).**
> Items marked ✅ below are complete. Remaining items are future work.

---

## How to Read This Document

Each upgrade is tagged with one of three cost tiers:

| Tag | Meaning |
|-----|---------|
| 🟢 **FREE** | Zero ongoing cost. Code changes only. |
| 🟡 **FREEMIUM** | Free tier available; paid tier unlocks higher limits or reliability. |
| 🔴 **PAID** | Requires a paid subscription or per-use billing. |

Sections are ordered by theme. A master priority table at the end cross-references everything.

---

## Table of Contents

1. [Increasing Result Volume & Yield](#1-increasing-result-volume--yield)
2. [Discovery & Data Sources](#2-discovery--data-sources)
3. [Scraping & Extraction Quality](#3-scraping--extraction-quality)
4. [Anti-Blocking & Reliability](#4-anti-blocking--reliability)
5. [Data Quality & Enrichment](#5-data-quality--enrichment)
6. [Frontend & UX](#6-frontend--ux)
7. [Export & Output Formats](#7-export--output-formats)
8. [Architectural Upgrades](#8-architectural-upgrades)
9. [Scalability Upgrades](#9-scalability-upgrades)
10. [Persistence & Storage](#10-persistence--storage)
11. [Operations & Observability](#11-operations--observability)
12. [Multi-Tenancy & Access Control](#12-multi-tenancy--access-control)
13. [Master Priority Table](#13-master-priority-table)

---

## 1. Increasing Result Volume & Yield

> The current system targets ~100 raw leads per run and yields ~50–80 after filtering.
> These upgrades directly increase how many qualified leads come out of each run.

### 1.1 Raise MAX_LEADS_PER_RUN Beyond 100 🟢 FREE

The `MAX_LEADS_PER_RUN` env var is currently defaulted to 100. Google Maps can return
200–300+ results for popular categories in large cities. Raising the cap costs nothing.

```env
MAX_LEADS_PER_RUN=200
```

- Risk: longer discovery time (more scrolling); higher CAPTCHA probability
- Mitigation: combine with proxy rotation (§4.1) to reduce block risk
- Expected yield: ~100–160 qualified leads per run instead of 50–80

### 1.2 Multi-Location Batching 🟢 FREE

Run the same keyword across multiple cities in a single job. Each location is scraped
sequentially; results are merged into one deduplicated leads array.

- UI: textarea accepting multiple locations (one per line)
- Backend: loop `runPipeline()` per location; share the dedup Set across all locations
- Dedup prevents the same business appearing twice if it has branches in multiple cities
- Example: `dental clinic` across London, Manchester, Birmingham → ~150–240 leads

### 1.3 Multi-Keyword Batching 🟢 FREE

Run multiple related keywords for the same location in one job.

- Example: `dental clinic`, `dentist`, `orthodontist` in `London, UK`
- UI: comma-separated keyword input or a tag input component
- Backend: loop discovery per keyword; shared dedup Set prevents duplicates
- Expected yield: 2–3× more leads per run with no extra scraping overhead per lead

### 1.4 Smarter Sub-Page Discovery (In-Depth Mode) 🟢 FREE

The current in-depth crawler follows a fixed URL pattern list. A relevance-scored approach
follows the most likely contact pages first, increasing email extraction yield.

- Score internal links by anchor text: "contact", "email", "reach us", "get in touch"
- Fallback to current pattern matching if no scored links found
- Configurable sub-page cap via `INDEPTH_MAX_SUBPAGES` env var (default 3, raise to 5–8)
- Expected email yield improvement: +10–20% on in-depth runs

### 1.5 JSON-LD / Schema.org Structured Data Extraction 🟢 FREE

Many business websites embed `<script type="application/ld+json">` blocks with
`LocalBusiness` schema containing phone, email, address, and hours. This is more reliable
than regex on visible text and often finds contacts that regex misses.

- Parse `LocalBusiness`, `Organization`, and `ContactPoint` schema types
- Use as the primary extraction pass; fall back to current mailto + regex approach
- Implementation: `extractFromStructuredData()` in `emailExtractor.ts` and `phoneNormalizer.ts`
- Expected yield improvement: +15–25% more emails found per run

### 1.6 Social Media Contact Extraction 🟢 FREE (with caveats)

Many businesses list contact info only on Facebook or Instagram, not their website.

- Facebook: public business pages expose phone and email in the "About" section
- Instagram: bio often contains email or a Linktree link with contact details
- Constraint: LinkedIn remains excluded (legal risk — see CONSTRAINTS.md §10)
- Risk: both platforms actively block automation; requires stealth + proxy for reliability
- Implementation: new `pipeline/socialScraper.ts` module; called after website scraping

### 1.7 Contact Form Detection & Flagging 🟢 FREE

When no email is found but a contact form exists, flag the lead with `hasContactForm: true`.
Outreach teams can manually submit the form. Prevents discarding leads that have a
reachable contact method — just not a scraped email.

- Detection: look for `<form>` with fields named `email`, `message`, `name`, `subject`
- Export: add a "Contact Form" column (Yes/No) to the Excel output
- No constraint violation — no email is guessed; the flag is informational only

### 1.8 Outscraper API for Higher-Volume Discovery �� FREEMIUM

Outscraper returns structured data for 100 businesses in ~5 seconds vs ~30–60s with
Playwright. The time saved per run can be reinvested into scraping more leads.

- Free tier: 500 records/month (~5 full runs)
- Paid: ~$3 per 1,000 records
- With Outscraper + `MAX_LEADS_PER_RUN=200`: ~100–160 qualified leads in ~2 minutes

### 1.9 Additional Directory Sources for Broader Coverage 🟡 FREEMIUM

Google Maps has gaps in certain regions and industries. Adding alternate sources fills them.

| Source | Region | Tier | Notes |
|--------|--------|------|-------|
| Yelp Fusion API | US, CA, AU | Freemium | 500 calls/day free; structured JSON |
| Bing Maps Local Search | Global | Freemium | Free tier available; JSON API |
| Justdial | India | Free (scrape) | High-value for IN-targeted runs |
| YellowPages | US, AU | Free (scrape) | No official API; Playwright scrape |
| TripAdvisor | Hospitality | Free (scrape) | Good for restaurants, hotels |

Each source implements the same `RawLead[]` interface. Selectable via `DISCOVERY_SOURCE`
env var or a UI dropdown. Running multiple sources per job and merging results (with dedup)
can push yield to 150–300 leads per run.

---
## 2. Discovery & Data Sources

### 2.1 Google Places API (New) 🔴 PAID

Returns structured JSON with name, address, phone, website, hours, and rating in a single
HTTP call — no browser required. Discovery drops from ~30–60s to ~1s.

- Cost: ~$0.017 per Text Search request; 5 requests = 100 results = ~$0.085/run
- Adds: business hours, ratings, review count, price level
- Implementation: new `pipeline/googlePlaces.ts`; same `RawLead[]` interface

### 2.2 Keyword Suggestions / Autocomplete 🟢 FREE

Curated chips below the keyword input for common business categories. Clicking fills the
field. Zero backend work — pure frontend React state.

Examples: "dental clinic", "law firm", "digital marketing agency", "plumber", "restaurant"

### 2.3 Location Autocomplete (Nominatim Suggest) 🟢 FREE

As the operator types a location, show a dropdown of matching place names from Nominatim's
`/search?format=json&q=<input>` endpoint. Prevents geocode failures from typos.

- Implementation: debounced fetch to Nominatim on location input change
- No API key required; respects Nominatim's 1 req/s rate limit

### 2.4 Bright Data / Apify Managed Scraping 🔴 PAID

Replace the local Playwright discovery scraper with a managed cloud scraping service.
No local browser, no CAPTCHA risk, no proxy management.

- Bright Data: ~$0.001/page; built-in proxy rotation + CAPTCHA solving
- Apify: $5/month free tier; Google Maps Actor available out of the box
- Best for: teams running 10+ jobs/day where local browser management is a bottleneck

---

## 3. Scraping & Extraction Quality

### 3.1 Configurable Sub-Page Depth 🟢 FREE

Make `INDEPTH_MAX_SUBPAGES` an env var (currently hard-coded to 3). Operators can raise
it to 5–8 for higher email yield at the cost of longer run times.

```env
INDEPTH_MAX_SUBPAGES=5
```

### 3.2 Social Media URL Extraction 🟢 FREE

Scan `<a href>` tags for known social domain patterns and store the URLs.

- New fields: `facebook`, `instagram`, `twitter` on the `Lead` type
- Export: optional columns in the Excel output (behind a config flag)
- Useful for outreach teams who prefer social DMs over cold email

### 3.3 Business Hours Extraction 🟢 FREE

Extract opening hours from JSON-LD structured data or the Google Maps detail panel.

- Source 1: `OpeningHoursSpecification` in JSON-LD (most reliable)
- Source 2: Maps detail panel text during discovery
- New field: `hours: string` on the `Lead` type (e.g. "Mon–Fri 9am–6pm")

### 3.4 Automatic Retry with Exponential Backoff 🟢 FREE

Failed website scrapes are currently marked `website_unreachable` and skipped. A retry
loop recovers transient failures (brief server overload, flaky connections).

- Max retries: 2 (configurable via `SCRAPE_MAX_RETRIES` env var)
- Backoff: 2s → 4s between attempts
- Only retry on timeout or 5xx; never retry on 4xx (permanent failure)
- Expected improvement: recover ~5–10% of currently-unreachable sites

### 3.5 DNS Pre-Resolution 🟢 FREE

Before scraping a batch, resolve all hostnames in parallel using Node's `dns.resolve()`.
Failed lookups are marked `website_unreachable` immediately — no browser launch needed.

- Saves: ~8–12s per dead domain (avoids full Playwright timeout)
- Common case: old Google Maps listings pointing to expired domains

### 3.6 Static-First Heuristics 🟢 FREE

Improve `detect.ts` with a domain-based lookup before making a network request:

- Known static hosts (GitHub Pages, Netlify, Squarespace static) → always Cheerio
- Known dynamic platforms (Shopify, WordPress+WooCommerce, Webflow) → always Playwright
- Saves the detection fetch for ambiguous cases only
- Implementation: a small lookup map in `detect.ts`; no network call needed

### 3.7 ScrapingBee / Zyte for Website Scraping 🟡 FREEMIUM

Replace the local Playwright website scraper with a managed API. Each page fetch is a
single HTTP request — no local browser overhead, no timeout management.

- ScrapingBee: 1,000 free API credits/month; ~$0.00045/request after
- Zyte (formerly Scrapy Cloud): free tier available
- Best for: replacing the dynamic Playwright path for business websites
- Not suitable for Google Maps discovery (they block Maps scraping)

---

## 4. Anti-Blocking & Reliability

### 4.1 Residential Proxy Pool Rotation 🔴 PAID

The current proxy support accepts a single `PROXY_URL`. Rotating across a pool of
residential proxies dramatically reduces CAPTCHA frequency on Google Maps.

- Providers: Bright Data (~$3/GB), Oxylabs, Smartproxy (~$3–8/month for typical usage)
- Implementation: `getProxyConfig()` in `antiBlocking.ts` picks a random proxy from a
  comma-separated `PROXY_POOL` env var on each browser launch
- Impact: near-zero CAPTCHA rate; enables `MAX_LEADS_PER_RUN=200+` reliably

### 4.2 CAPTCHA Auto-Solving 🔴 PAID

When a CAPTCHA is detected, the current system stops discovery. Integrating a solving
service allows the job to continue automatically.

- Services: 2captcha (~$1/1,000 solves), Anti-Captcha, CapSolver
- Cost: ~$0.001 per solve — negligible for typical usage
- Implementation: on CAPTCHA detection, submit the challenge, wait for token, inject + resume

### 4.3 Headful Mode for Debugging 🟢 FREE

Add a `PLAYWRIGHT_HEADLESS=false` env var. Launches the browser visibly for debugging
CAPTCHA issues and selector breakage without code changes.

### 4.4 Browser Context Pooling 🟢 FREE

Currently a single shared browser context is used for all scraping. Separate contexts
per batch prevent one site's cookies/state from affecting others.

- Implementation: context pool in `scraper.ts` alongside the existing page pool
- Tradeoff: higher memory usage (~50MB per context); worth it for dynamic-heavy runs

### 4.5 Graceful CAPTCHA Recovery with Wait + Retry 🟢 FREE

Instead of stopping on CAPTCHA, wait a configurable `CAPTCHA_WAIT_MS` (default 60s) and
retry discovery from the last successful position.

```env
CAPTCHA_WAIT_MS=60000
CAPTCHA_MAX_RETRIES=2
```

---

## 5. Data Quality & Enrichment

### 5.1 Business Category / Industry Tag 🟢 FREE

Google Maps returns a business category (e.g. "Dental clinic", "Law firm"). Capturing it
enables filtering and sorting by industry in the export.

- Source: Maps detail panel during discovery (already visited)
- New field: `category: string` on the `Lead` type
- Export: add a "Category" column to the Excel output

### 5.2 Rating & Review Count 🟢 FREE

Google Maps ratings are publicly available and a useful proxy for business activity.

- New fields: `rating: number`, `reviewCount: number` on the `Lead` type
- Source: Maps detail panel during discovery
- Export: "Rating" and "Reviews" columns; sort by rating in UI

### 5.3 Lead Scoring 🟢 FREE

Combine multiple signals into a numeric score (0–100) to help outreach teams prioritize:

| Signal | Points |
|--------|--------|
| Has both email + phone | +40 |
| Has website | +20 |
| Rating ≥ 4.0 | +15 |
| Review count ≥ 10 | +10 |
| Has social media links | +10 |
| Has contact form | +5 |

- New field: `score: number` on the `Lead` type
- Export: "Score" column; sort descending by default
- UI: score badge in the results table

### 5.4 Cross-Run Deduplication 🟢 FREE

The dedup Set is cleared on `store.reset()`, so the same business can appear in multiple
runs. A persistent dedup store prevents re-scraping known businesses.

- Implementation: load `cache/seen_keys.json` on startup; append new keys after each run
- Opt-in: `CROSS_RUN_DEDUP=true` env var
- Note: requires relaxing Constraint #2 (no file writes) for this specific cache file

### 5.5 Email Verification (Syntax + MX Check) 🟢 FREE

Without SMTP probing (Constraint #3), a lightweight two-step check still filters junk:

1. Syntax validation: RFC 5322 regex
2. MX record lookup: `dns.resolveMx(domain)` — confirms the domain accepts email

- Filters domains with no MX record (dead domains, placeholder sites)
- Does not violate Constraint #3 — no SMTP connection is made
- Implementation: add `validateEmailDomain()` in `emailExtractor.ts`

### 5.6 Hunter.io / Apollo.io Email Enrichment 🔴 PAID

If no email is found on the website, query an enrichment API with the business name and
domain to retrieve a likely contact email.

- Hunter.io: 25 free searches/month; $49/month for 500
- Apollo.io: free tier available; $49/month for higher limits
- Note: relaxes Constraint #1 (no email guessing) — requires explicit sign-off
- These APIs return emails sourced from public data, not generated patterns

---

## 6. Frontend & UX

### 6.1 Column Sorting & Filtering 🟢 FREE

The current table renders leads in arrival order. Client-side sort and filter controls
make it much easier to work with 50–150 leads.

- Sort by: Business Name, Email (present/absent), Phone, Rating, Score
- Filter by: has email, has phone, has both, has website, category
- Pure React state — no backend changes needed

### 6.2 Search / Filter Bar 🟢 FREE

A text input above the table that filters rows by business name, email domain, or address
substring. Client-side only, instant feedback.

### 6.3 Failure Metrics Panel 🟢 FREE

The backend already tracks `failureMetrics` and exposes them via `GET /api/status`.
The frontend currently ignores these. A collapsible "Diagnostics" panel would surface:

- Websites unreachable, emails not found, phones not found, duplicates skipped, CAPTCHAs blocked
- Helps operators understand why a run produced fewer leads than expected

### 6.4 Progress Bar 🟢 FREE

Show a progress bar during scraping based on `leadCount / MAX_LEADS_PER_RUN`. The backend
already emits `leadCount` on every SSE status event — the frontend just needs to render it.

### 6.5 Job History 🟢 FREE

Show the last N jobs (keyword, location, lead count, timestamp) in a sidebar. Clicking a
past job restores its leads from `localStorage` or `IndexedDB`. No backend changes needed.

### 6.6 Lead Detail Drawer 🟢 FREE

Clicking a row opens a side drawer with full lead details including category, rating, hours,
social links, and score. No backend changes if extra fields are already in the SSE payload.

### 6.7 Dark Mode 🟢 FREE

Tailwind `dark:` variant classes + a toggle button. State persisted in `localStorage`.

### 6.8 Keyboard Shortcuts 🟢 FREE

- `Enter` in keyword/location field → Start (when not running)
- `Escape` → Stop (when running)
- `Ctrl+E` / `Cmd+E` → Export

---

## 7. Export & Output Formats

### 7.1 CSV Export 🟢 FREE

Plain CSV alongside the existing Excel export. Useful for CRM imports.

- Implementation: `GET /api/export?format=csv`; reuse the sorted leads array
- Note: relaxes Constraint #9 (Excel only) — requires explicit sign-off

### 7.2 JSON Export 🟢 FREE

Raw JSON export of the leads array. Useful for developers integrating the scraper.

- Implementation: `GET /api/export?format=json` — trivially simple

### 7.3 Configurable Export Columns 🟢 FREE

Allow operators to choose which columns appear in the export via a settings panel.

- UI: checkbox list in a settings modal
- Backend: pass a `columns` array to `generateExcel()`
- Note: relaxes Constraint #9 (no field picker) — requires explicit sign-off

### 7.4 Scheduled / Auto-Export on Completion 🟢 FREE

Automatically write the .xlsx to a configured `EXPORT_DIR` folder when a job completes.
Useful for unattended overnight runs.

- Note: relaxes Constraint #2 (no file writes) for the export file specifically

### 7.5 CRM Direct Push 🟡 FREEMIUM

Push leads directly to a CRM via API instead of downloading a file.

| CRM | API | Tier |
|-----|-----|------|
| HubSpot | Contacts API v3 | Free tier available |
| Pipedrive | Persons API | Free tier available |
| Airtable | Records API | Free tier available |
| Google Sheets | Sheets API v4 | Free; requires OAuth |
| Salesforce | REST API | Paid |

- Implementation: new `POST /api/export/crm` route; CRM credentials in `.env`

### 7.6 Webhook on Job Completion 🟢 FREE

POST a JSON payload to a configurable `WEBHOOK_URL` when a job finishes. Triggers
downstream workflows in Zapier, Make, n8n, or Slack.

```json
{
  "event": "job_completed",
  "jobId": "abc-123",
  "keyword": "dental clinic",
  "location": "London, UK",
  "leadCount": 52,
  "discardCount": 18,
  "durationMs": 87000
}
```

---
## 8. Architectural Upgrades

> These upgrades change how the system is structured internally. They improve
> maintainability, testability, and the ability to add features without breaking existing ones.

### 8.1 Plugin-Based Discovery Architecture 🟢 FREE

Currently `discovery.ts` is a single module with one strategy (Playwright on Google Maps).
Refactoring to a plugin interface makes adding new sources trivial and keeps each source
independently testable.

```typescript
// pipeline/sources/types.ts
interface DiscoverySource {
  name: string;
  discover(keyword: string, location: string, limit: number): Promise<RawLead[]>;
}

// pipeline/sources/googleMaps.ts  — current implementation
// pipeline/sources/outscraper.ts  — new
// pipeline/sources/yelp.ts        — new
// pipeline/sources/bing.ts        — new
```

- `DISCOVERY_SOURCE=googleMaps,yelp` env var runs both and merges results
- Each source is independently unit-testable
- Adding a new source = one new file, no changes to pipeline.ts

### 8.2 Event-Driven Pipeline with an Internal Event Bus 🟢 FREE

The current pipeline is a linear function call chain. Replacing it with an internal
event bus (Node.js `EventEmitter` or a tiny pub/sub) decouples stages and makes it
easy to add new consumers (e.g. a real-time analytics listener) without touching the
core pipeline.

```typescript
// pipeline/events.ts
const bus = new EventEmitter();
bus.on('lead:qualified', (lead) => { store.addLead(lead); emitSSE(lead); });
bus.on('lead:qualified', (lead) => { scorer.score(lead); });  // add without touching pipeline
bus.on('lead:discarded', (raw) => { store.incrementDiscard(); emitSSEDiscard(); });
```

### 8.3 Queue-Based Job Management (BullMQ) 🟡 FREEMIUM

Replace the current single-job-at-a-time model with a proper job queue. Jobs are
submitted to a queue and processed by workers. Multiple jobs can be queued; they run
sequentially (or in parallel with multiple workers).

- Library: BullMQ (requires Redis)
- Benefits: job persistence across restarts, retry on crash, job priority, scheduled jobs
- Redis: free self-hosted; Redis Cloud free tier (30MB) sufficient for a queue

```
UI → POST /api/start → BullMQ queue → worker process → SSE back to UI
```

### 8.4 Separate Discovery and Scraping Workers 🟢 FREE

Currently discovery and scraping run in the same Node.js process. Splitting them into
separate `worker_threads` isolates crashes (a scraper crash doesn't kill discovery) and
allows independent scaling.

```
Main process: API server + SSE + store
Worker 1:     Discovery (Google Maps Playwright)
Worker 2–N:   Website scraping (Playwright page pool)
```

- Communication: `MessageChannel` between main and workers
- No external dependencies; uses Node.js built-ins

### 8.5 Configuration Schema Validation on Startup 🟢 FREE

Currently env vars are read inline with `process.env.X ?? 'default'`. Adding a startup
validation step (using `zod` or `joi`) catches misconfiguration before any scraping begins.

```typescript
// config.ts
const Config = z.object({
  PORT: z.coerce.number().default(4000),
  SCRAPE_CONCURRENCY: z.coerce.number().min(1).max(50).default(10),
  PROXY_URL: z.string().url().optional(),
  // ...
});
export const config = Config.parse(process.env);
```

- Fails fast with a clear error message instead of silently using wrong defaults
- Makes all configuration visible in one place

### 8.6 OpenAPI / Swagger Documentation 🟢 FREE

Auto-generate API documentation from the Express routes using `swagger-jsdoc` +
`swagger-ui-express`. Accessible at `GET /api/docs`.

- Documents all endpoints, request bodies, response shapes, and error codes
- Useful for team members integrating the API programmatically

### 8.7 Docker Containerization 🟢 FREE

Package the backend (and optionally the frontend) as Docker images. Simplifies deployment
to any VPS, cloud provider, or local machine without manual Node.js setup.

```dockerfile
FROM mcr.microsoft.com/playwright:v1.44.0-jammy
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
CMD ["node", "dist/index.js"]
```

- Playwright Chromium is pre-installed in the official Playwright Docker image
- `docker-compose.yml` can wire backend + frontend + optional Redis together
- Eliminates "works on my machine" deployment issues

### 8.8 Structured Error Types �� FREE

Replace generic `Error` throws with typed error classes. Makes error handling in the
pipeline explicit and testable.

```typescript
class GeocodeFailed extends Error { constructor(location: string) { super(`...`); } }
class CaptchaDetected extends Error {}
class WebsiteUnreachable extends Error { constructor(url: string, statusCode: number) { ... } }
```

- Pipeline catch blocks can handle each error type differently
- Tests can assert on specific error types instead of message strings

---

## 9. Scalability Upgrades

> These upgrades allow the system to handle larger volumes, more concurrent users,
> and higher-frequency runs without degrading performance or reliability.

### 9.1 Horizontal Scaling with Worker Processes 🟢 FREE

For runs targeting 500+ leads, distribute scraping across multiple Node.js worker threads.
Each worker handles a subset of the deduped leads array.

```
Main process → splits dedupedLeads into N chunks → N worker_threads
Each worker → scrapes its chunk → posts results back via MessageChannel
Main process → merges results → emits SSE
```

- No external dependencies; uses Node.js `worker_threads`
- Pool size: `WORKER_COUNT` env var (default: `os.cpus().length - 1`)
- Practical for 200–1,000 lead runs

### 9.2 Redis-Backed Job Queue for Multi-Instance Deployments 🟡 FREEMIUM

For deployments with multiple backend instances (load-balanced VPS or Kubernetes), a
Redis-backed queue (BullMQ) ensures only one instance processes each job.

- Redis Cloud free tier: 30MB — sufficient for a job queue
- Each backend instance is a BullMQ worker; jobs are claimed atomically
- SSE connections are routed to the instance processing the job (or via Redis pub/sub)

### 9.3 Persistent Robots.txt Cache 🟢 FREE

The current robots.txt cache is in-memory and cleared on restart. A JSON file cache
means repeat runs against the same domains skip the fetch entirely.

- Implementation: load `cache/robots_cache.json` on startup; write on update
- Savings: ~0.2–0.5s per domain, compounding across runs

### 9.4 CDN + Edge Caching for the Frontend 🟡 FREEMIUM

Deploy the Next.js frontend to Vercel (free tier) or Cloudflare Pages (free tier).
The backend stays on a VPS. The frontend is served from a CDN edge — faster globally.

- Frontend: Vercel / Cloudflare Pages (free)
- Backend: VPS (unchanged — Playwright requires persistent process)
- `NEXT_PUBLIC_API_URL` points to the VPS backend

### 9.5 Database-Backed Store for High-Volume Runs 🟢 FREE (SQLite) / 🔴 PAID (Postgres)

For runs producing 500+ leads, the in-memory array becomes a bottleneck for export
(sorting 500+ objects in memory). A database-backed store handles this efficiently.

- SQLite (`better-sqlite3`): zero-config, file-based, free — good up to ~10,000 leads
- PostgreSQL: required for multi-user, multi-instance deployments

### 9.6 Streaming Excel Export for Large Result Sets 🟢 FREE

The current exporter already has a streaming path for `leads.length > 500`. Lowering
this threshold to 100 and always using the streaming writer eliminates memory spikes
during export regardless of result set size.

- Change: remove the buffer path; always use `ExcelJS.stream.xlsx.WorkbookWriter`
- Memory usage during export: O(1) instead of O(n)

### 9.7 Job Timeout Guard 🟢 FREE

Add a configurable `JOB_TIMEOUT_MS` env var (default: 10 minutes). If a job exceeds
this duration, it is automatically stopped and marked `error`. Prevents runaway jobs
from consuming resources indefinitely.

```env
JOB_TIMEOUT_MS=600000
```

### 9.8 Health Check & Readiness Endpoints 🟢 FREE

Standard endpoints for load balancers, Docker health checks, and uptime monitors.

- `GET /health` → `{ status: "ok", uptime: 123, version: "1.0.0" }`
- `GET /ready` → `{ ready: true }` (false if a job is already running)
- Implementation: ~10 lines of Express code; no dependencies

### 9.9 Prometheus Metrics Endpoint 🟢 FREE

Expose a `GET /metrics` endpoint in Prometheus text format. Enables dashboards and
alerting in production deployments.

Metrics to expose:
- `leads_total` (counter)
- `discards_total` (counter)
- `jobs_total{status}` (counter)
- `scrape_duration_seconds` (histogram)
- `captcha_blocks_total` (counter)
- `active_sse_connections` (gauge)

- Library: `prom-client` (MIT license, zero config)

---

## 10. Persistence & Storage

> Items marked ⚠️ require relaxing Constraint #2 (no persistent storage).

### 10.1 Auto-Save JSON Snapshot on Job Completion 🟢 FREE ⚠️

Write a JSON snapshot of `leads[]` to disk at job completion. On server restart, load
the most recent snapshot automatically. Lightweight middle ground before a full database.

```typescript
// On job complete:
fs.writeFileSync('data/last_run.json', JSON.stringify(leads, null, 2));

// On startup:
if (fs.existsSync('data/last_run.json')) {
  leads = JSON.parse(fs.readFileSync('data/last_run.json', 'utf8'));
}
```

### 10.2 SQLite Session Store 🟢 FREE ⚠️

Replace the in-memory `leads[]` array with a SQLite database. Leads survive restarts.
Multiple past runs are queryable.

- Library: `better-sqlite3` (synchronous, zero-config, no server needed)
- Schema: `leads` table + `jobs` table with timestamps and metadata
- Export still works the same way — query the DB instead of the in-memory array

### 10.3 PostgreSQL for Multi-User Deployments 🔴 PAID ⚠️

For team deployments where multiple operators share one server, PostgreSQL allows
concurrent jobs, per-user lead isolation, and historical reporting.

- Hosted options: Supabase (free tier: 500MB), Railway ($5/month), Neon (free tier)

---

## 11. Operations & Observability

### 11.1 Structured JSON Logging �� FREE

Switch Winston to JSON format for compatibility with log aggregation tools.

```json
{ "timestamp": "2026-05-04T10:23:01Z", "level": "info", "message": "Lead found",
  "businessName": "Acme Dental", "jobId": "abc-123", "hasEmail": true, "hasPhone": true }
```

- Implementation: `winston.format.json()` transport
- Compatible with: Datadog, Grafana Loki, AWS CloudWatch, Papertrail

### 11.2 Graceful Shutdown on SIGTERM 🟢 FREE

Ensures clean shutdown when killed by pm2, Docker, or the OS.

```typescript
process.on('SIGTERM', async () => {
  signalStop();
  await forceCloseBrowser();
  await closeScraperBrowser();
  server.close(() => process.exit(0));
});
```

### 11.3 Datadog / Grafana Cloud Monitoring 🟡 FREEMIUM

Ship logs and metrics to a hosted monitoring platform.

- Datadog: free tier (1 host, 1-day retention)
- Grafana Cloud: free tier (10,000 metrics/month, 50GB logs)
- New Relic: free tier (100GB/month)

### 11.4 Uptime Monitoring 🟡 FREEMIUM

Monitor the `/health` endpoint from an external service.

- UptimeRobot: free tier (50 monitors, 5-minute checks)
- Better Uptime: free tier available
- Alerts via email, Slack, or PagerDuty on downtime

---

## 12. Multi-Tenancy & Access Control

### 12.1 Basic Authentication 🟢 FREE

Single `ADMIN_PASSWORD` env var protecting all routes. Sufficient for a single-operator
deployment.

- Backend: `express-basic-auth` middleware
- Frontend: Next.js middleware to protect all pages

### 12.2 API Key Authentication 🟢 FREE

API key authentication for programmatic access. Keys stored as a comma-separated list
in `.env` — no database needed for a small key list.

- Header: `X-API-Key: <key>`
- Implementation: custom Express middleware (~20 lines)

### 12.3 Per-User Job Isolation 🟢 FREE

Scope each job to the user who started it. Users can only see and export their own leads.

- Requires: authentication (§12.1 or §12.2) + per-user store partitioning
- Implementation: replace the global `store` singleton with a `Map<userId, Store>`

### 12.4 Usage Quotas 🟢 FREE

Limit jobs per user per day to prevent abuse in shared deployments.

- In-memory counter per API key; reset at midnight UTC
- Configurable via `MAX_JOBS_PER_DAY_PER_KEY` env var

---

## 13. Master Priority Table

Segregated by cost tier, ordered by impact within each tier.

### 🟢 FREE — Highest Impact First

Items marked ✅ were implemented in May 2026 as part of `docs/FREE_UPGRADES_PLAN.md`.

| # | Upgrade | Impact | Effort | Section | Status |
|---|---------|--------|--------|---------|--------|
| 1 | JSON-LD structured data extraction | 🔴 High | 🟢 Low | §3.5 / §1.5 | ✅ Done |
| 2 | Multi-keyword batching | 🔴 High | 🟢 Low | §1.3 | ✅ Done |
| 3 | Multi-location batching | 🔴 High | 🟡 Medium | §1.2 | ✅ Done |
| 4 | Raise MAX_LEADS_PER_RUN to 200 | 🔴 High | 🟢 Low | §1.1 | ✅ Done |
| 5 | Automatic retry with backoff | 🟡 Medium | 🟢 Low | §3.4 | ✅ Done |
| 6 | DNS pre-resolution | 🟡 Medium | 🟢 Low | §3.5 | ✅ Done |
| 7 | Contact form detection & flagging | 🟡 Medium | 🟢 Low | §1.7 | ✅ Done |
| 8 | Email MX validation | 🟡 Medium | 🟢 Low | §A2 | ✅ Done |
| 9 | Static-first heuristics | 🟡 Medium | 🟢 Low | §3.6 | ✅ Done |
| 10 | Improved in-depth crawl (scored, max 5 pages) | 🟡 Medium | 🟢 Low | §D1 | ✅ Done |
| 11 | Failure metrics panel in UI | 🟡 Medium | 🟢 Low | §6.3 | — |
| 12 | Column sorting & filtering | 🟡 Medium | 🟢 Low | §6.1 | — |
| 13 | Progress bar | 🟢 Low | 🟢 Low | §6.4 | — |
| 14 | CSV export | 🟡 Medium | 🟢 Low | §7.1 | — |
| 15 | Webhook on job completion | 🟡 Medium | 🟢 Low | §7.6 | — |
| 16 | Health check endpoint | 🟢 Low | 🟢 Low | §9.8 | — |
| 17 | Graceful SIGTERM shutdown | 🟡 Medium | 🟢 Low | §11.2 | — |
| 18 | Job timeout guard | 🟡 Medium | 🟢 Low | §9.7 | — |
| 19 | Business category extraction | 🟡 Medium | 🟢 Low | §5.1 | — |
| 20 | Rating & review count | 🟡 Medium | 🟢 Low | §5.2 | — |
| 21 | Lead scoring | 🟡 Medium | 🟡 Medium | §5.3 | — |
| 22 | Cross-run deduplication | 🟡 Medium | 🟡 Medium | §5.4 | — |
| 23 | Plugin-based discovery architecture | 🟡 Medium | 🟡 Medium | §8.1 | — |
| 24 | Docker containerization | 🟡 Medium | 🟡 Medium | §8.7 | — |
| 25 | Config schema validation (zod) | 🟢 Low | 🟢 Low | §8.5 | — |
| 26 | Horizontal worker scaling | 🟡 Medium | 🔴 High | §9.1 | — |
| 27 | SQLite session store | 🟡 Medium | 🟡 Medium | §10.2 | — |
| 28 | Prometheus metrics | 🟢 Low | 🟡 Medium | §9.9 | — |

### 🟡 FREEMIUM — Free Tier Available

| # | Upgrade | Impact | Monthly Cost | Section |
|---|---------|--------|-------------|---------|
| 1 | Outscraper API (500 records/month free) | 🔴 High | $0–$3 | §1.8 / §2.1 |
| 2 | Yelp Fusion API (500 calls/day free) | 🟡 Medium | $0–$10 | §1.9 |
| 3 | Bing Maps Local Search (free tier) | 🟡 Medium | $0–$5 | §1.9 |
| 4 | ScrapingBee (1,000 credits/month free) | 🟡 Medium | $0–$29 | §3.7 |
| 5 | CRM push — HubSpot / Airtable (free tier) | 🔴 High | $0 | §7.5 |
| 6 | Redis Cloud for job queue (30MB free) | 🟡 Medium | $0–$7 | §9.2 |
| 7 | Grafana Cloud monitoring (free tier) | 🟢 Low | $0–$10 | §11.3 |
| 8 | UptimeRobot (50 monitors free) | 🟢 Low | $0 | §11.4 |
| 9 | Supabase PostgreSQL (500MB free) | 🟡 Medium | $0–$25 | §10.3 |
| 10 | Vercel / Cloudflare Pages for frontend | 🟢 Low | $0 | §9.4 |

### 🔴 PAID — Requires Budget

| # | Upgrade | Impact | Est. Cost | Section |
|---|---------|--------|-----------|---------|
| 1 | Residential proxy rotation | 🔴 High | ~$3–8/month | §4.1 |
| 2 | CAPTCHA auto-solving (2captcha) | 🔴 High | ~$1/1k solves | §4.2 |
| 3 | Google Places API | 🔴 High | ~$0.09/run | §2.1 |
| 4 | Bright Data / Apify managed scraping | 🔴 High | ~$5–20/month | §2.4 |
| 5 | Hunter.io / Apollo.io email enrichment | 🟡 Medium | $49+/month | §5.6 |
| 6 | PostgreSQL (Railway / Neon) | 🟡 Medium | $5–10/month | §10.3 |

---

*Last updated: May 2026 — Phase 11 complete + all 10 FREE upgrades from FREE_UPGRADES_PLAN.md implemented.*

