# Implementation Context

> Single source of truth for any developer picking up this project.
> Derived from `Lead_Scraper_Blueprint_Final.md` — updated for free stack in Phase 2.

---

## System Summary

The Lead Generation Scraper is an in-house tool for email marketing and cold-calling teams. Given a keyword (e.g. "digital marketing agency") and a location (e.g. "Noida, India"), it:

1. Validates the location via **OpenStreetMap Nominatim** (free, no API key).
2. Discovers up to 100 businesses via **Playwright on Google Maps** (free, no Outscraper).
3. Deduplicates the raw list in memory.
4. Scrapes each business website for email and phone (static pages via Cheerio, dynamic pages via Playwright).
5. Filters out leads with no contact method.
6. Streams qualifying leads to the operator's browser in real time via SSE.
7. Exports a sorted, highlighted `.xlsx` file on demand.

**No database. No persistent storage. No paid APIs. All data lives in memory for the current server process.**

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20 LTS + TypeScript 5 |
| Frontend | Next.js 14 (App Router) + React 18 + Tailwind CSS 3 |
| Backend | Express 4 |
| Crawling | Crawlee 3 + Playwright (Chromium) |
| Static parsing | Cheerio |
| Discovery | **Playwright on Google Maps** (free — no Outscraper) |
| Geocoding | **OpenStreetMap Nominatim** (free — no Google Geocoding API) |
| Phone normalisation | libphonenumber-js |
| Domain parsing | tldts |
| Excel export | exceljs |
| Real-time updates | Server-Sent Events (SSE) |
| Logging | winston |

---

## Architecture Overview

```
Next.js Dashboard (UI)
        │  keyword + location + depth
        ▼
Express API (/api/start, /api/stop, /api/status, /api/stream, /api/export)
        │
        ├─► Geocoder (Nominatim — validate location, extract ISO country code, retry on failure)
        │
        ├─► Discovery Module (Playwright on Google Maps)
        │       ├─ Navigate to maps.google.com/search/<keyword>+<location>
        │       ├─ Wait for [role="feed"], scroll until ~100 results
        │       ├─ Click each card → extract name, address, phone, website
        │       ├─ 2–4s delay + ±500ms jitter between card interactions
        │       └─ CAPTCHA detection → increment metric + SSE error + stop safely
        │
        ├─► Deduplicator (in-memory Set, key: normalizedPhone|rootDomain via tldts)
        │
        ├─► Detail Scraper (per business with a website URL) [Phase 3]
        │       ├─ Static Detector (2s timeout, JS framework marker check)
        │       ├─ Cheerio path (static pages)
        │       └─ Playwright path (dynamic pages, waitUntil: networkidle)
        │
        ├─► Email Extractor (mailto links → regex → blacklist → noise filter → priority rank) [Phase 3]
        ├─► Phone Normalizer (libphonenumber-js, E.164, ISO hint from Geocoder) [Phase 3]
        │
        ├─► Filter (post-scrape only: discard if no email AND no phone) [Phase 3]
        ├─► Quality Tier (Tier1: both, Tier2: email only, Tier3: phone only) [Phase 3]
        │
        ├─► In-Memory Store (leads[], discardCount, failureMetrics, jobStatus)
        ├─► SSE Endpoint (push lead/discard/status/error events to Dashboard)
        │
        └─► Exporter (sort by _hasBoth, green-highlight Tier1, stream .xlsx)
```

---

## Pipeline Steps (in order)

| Step | Name | Description | Phase |
|------|------|-------------|-------|
| 1 | Geocode Validation | Nominatim → validate location, extract ISO country code. Retry once with cleaned query. | 2 ✅ |
| 2 | Discovery | Playwright on Google Maps → scroll feed → click cards → extract name/address/phone/website. | 2 ✅ |
| 3 | Deduplication | Key = `normalizedPhone\|rootDomain` (tldts). Skip if key seen. | 2 ✅ |
| 4 | Basic Parse | Extract name, address, phone, website. Normalise URL (https://, no trailing slash). | 2 ✅ |
| 5 | Static Detection | 2s GET + JS marker check → Cheerio (static) or Playwright (dynamic). | 3 ✅ |
| 6 | Website Scraping | Fetch homepage HTML. Unreachable → mark metric, continue. | 3 ✅ |
| 7 | Email Extraction | mailto → regex → dedup → blacklist → noise filter → priority rank → single best email. | 4 ✅ |
| 8 | Phone Normalisation | libphonenumber-js with ISO hint → E.164. Discovery phone takes priority over website phone. | 4 ✅ |
| 9 | Filter | Discard if email AND phone both empty. Runs ONLY after all scraping is complete. | 5 ✅ |
| 10 | Quality Tier | Tier1 (both), Tier2 (email only), Tier3 (phone only). Internal only, not exported. | 5 ✅ |
| 11 | Store + SSE | Push to leads[]. Emit SSE `lead` event to Dashboard immediately. | 5 ✅ |
| 12 | Export | Sort (Tier1 first), green-highlight Tier1 rows, stream .xlsx. | 1 ✅ |

---

## Discovery Flow (Phase 2)

```
POST /api/start { keyword, location, depth }
        │
        ▼
Nominatim geocode → ISO country code
        │
        ▼
Playwright launches Chromium (headless)
        │
        ▼
Navigate: https://www.google.com/maps/search/<keyword>+<location>
        │
        ▼
Wait for [role="feed"] (20s timeout)
        │
        ▼
Scroll feed loop:
  - scrollBy(0, 1000) every 1.5s
  - stop when count >= 100 OR 3 consecutive scrolls with no new results
        │
        ▼
For each card in [role="feed"] > div[jsaction]:
  - CAPTCHA check → if detected: increment captcha_blocked, emit SSE error, stop
  - click card → wait for detail panel
  - extract: name, address, phone, website
  - apply 2–4s delay + ±500ms jitter
        │
        ▼
Deduplication (normalizedPhone|rootDomain via tldts)
        │
        ▼
Raw leads ready for Phase 3 (website scraping)
```

---

## Critical Rules

See `/docs/CONSTRAINTS.md` for the full non-negotiable list. Key rules:

- **No paid APIs** — Nominatim for geocoding, Playwright for discovery. Zero cost.
- **No email guessing** — only scraped emails, never domain-pattern generated.
- **No storage** — in-memory only; data lost on server restart.
- **Filter runs post-scrape only** — never discard during discovery.
- **Stop terminates within 10 seconds** — hard timeout, force-close browser contexts.
- **Phone in E.164 format** — always normalised via libphonenumber-js.
- **Dedup key** = `normalizedPhone|rootDomain` (tldts).
- **CAPTCHA handling** — increment metric, emit SSE error, stop discovery safely.

---

## Phase Breakdown

| Phase | Name | Scope | Status |
|-------|------|-------|--------|
| 1 | MVP Scaffold | Express server, store, SSE, exporter, all API routes | ✅ Complete |
| 2 | Discovery + Geocoding | Nominatim geocoder, Playwright Maps discovery, deduplicator | ✅ Complete |
| 3 | Website Scraping Engine | Static detection, Cheerio/Playwright fetch, unreachable handling | ✅ Complete |
| 4 | Extraction Logic | Email extraction (blacklist/rank), phone normalisation (E.164), metrics | ✅ Complete |
| 5 | Filter + SSE Lead Emit | Post-scrape filter, quality tier, store.addLead(), emitLead() | ✅ Complete |
| 6 | Frontend Dashboard | Next.js 14 UI — inputs, SSE table, status bar, export button | ✅ Complete |
| 7 | Excel Export | Sort, green highlight, hyperlinks, streaming >500 — built in Phase 1 | ✅ Complete |
| 8 | In-Depth Crawl | homepage + max 3 sub-pages, 30s timeout, subpages_scraped metric | ✅ Complete |
| 9 | Anti-Blocking | playwright-extra stealth, UA/viewport rotation, proxy support | ✅ Complete |
| 10 | Compliance & Operations | File logging, rate limiting, robots.txt, runbook | ✅ Complete |

---

## Folder Structure (Current)

```
/
├── docs/
│   ├── IMPLEMENTATION_CONTEXT.md
│   ├── PROGRESS.md
│   ├── CONSTRAINTS.md
│   ├── PHASE_1_SUMMARY.md
│   ├── PHASE_2_SUMMARY.md
│   └── PHASE_3_SUMMARY.md
├── backend/
│   ├── src/
│   │   ├── index.ts                ← Express server entry point
│   │   ├── types.ts                ← All type definitions
│   │   ├── store.ts                ← In-memory store
│   │   ├── sse.ts                  ← SSE connection manager
│   │   ├── exporter.ts             ← Excel export
│   │   ├── logger.ts               ← Winston logger
│   │   ├── routes/
│   │   │   ├── start.ts            ← POST /api/start (Nominatim + pipeline)
│   │   │   ├── stop.ts             ← POST /api/stop (10s hard timeout)
│   │   │   ├── status.ts           ← GET /api/status
│   │   │   ├── stream.ts           ← GET /api/stream (SSE)
│   │   │   └── export.ts           ← GET /api/export
│   │   └── pipeline/
│   │       ├── geocoder.ts         ← Nominatim location validation
│   │       ├── discovery.ts        ← Playwright Google Maps scraper
│   │       ├── deduplicator.ts     ← tldts-based dedup key builder
│   │       ├── detect.ts           ← Static vs dynamic page detection
│   │       ├── scraper.ts          ← Website fetch engine (Cheerio/Playwright)
│   │       ├── emailExtractor.ts   ← Email extraction (blacklist + domain rank)
│   │       ├── phoneNormalizer.ts  ← Phone extraction + E.164 normalisation
│   │       ├── indepth.ts          ← In-depth crawl (homepage + max 3 sub-pages)
│   │       ├── filter.ts           ← Post-scrape filter + quality tier + SSE emit
│   │       ├── pipeline.ts         ← Job orchestrator (COMPLETE)
│   │       ├── geocoder.test.ts
│   │       ├── deduplicator.test.ts
│   │       ├── detect.test.ts
│   │       ├── scraper.test.ts
│   │       ├── emailExtractor.test.ts
│   │       ├── phoneNormalizer.test.ts
│   │       └── filter.test.ts
│   ├── package.json
│   ├── tsconfig.json
│   └── .env.example
├── frontend/
│   ├── src/
│   │   ├── app/
│   │   │   ├── layout.tsx          ← Root layout + Tailwind CSS
│   │   │   ├── page.tsx            ← Dashboard (SSE wired, all state)
│   │   │   └── globals.css
│   │   ├── components/
│   │   │   ├── InputPanel.tsx      ← keyword, location, depth, Start/Stop
│   │   │   ├── StatusBar.tsx       ← live status, lead/discard counts
│   │   │   ├── ResultsTable.tsx    ← 5-column table, green Tier1 rows
│   │   │   └── ExportButton.tsx    ← triggers /api/export download
│   │   ├── hooks/
│   │   │   └── useSSE.ts           ← EventSource hook (lead/discard/status/error)
│   │   └── types.ts                ← Frontend type definitions
│   ├── next.config.js              ← /api/* proxy to Express backend
│   ├── tailwind.config.js
│   ├── tsconfig.json
│   └── .env.local
└── Lead_Scraper_Blueprint_Final.md
```

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/start` | Start a new job (keyword, location, depth) |
| POST | `/api/stop` | Stop the running job (10s hard timeout) |
| GET | `/api/status` | Current job status + stats + failure metrics |
| GET | `/api/stream` | SSE stream of lead/discard/status/error events |
| GET | `/api/export` | Download leads as .xlsx |

---

## Data Model

```typescript
type QualityTier = 'Tier1' | 'Tier2' | 'Tier3';
type JobStatus = 'idle' | 'running' | 'stopped' | 'completed' | 'error';

interface Lead {
  businessName: string;   // always present
  email: string;          // empty string if not found — NEVER guessed
  phone: string;          // E.164 format, empty string if not found
  website: string;        // full URL with https://, empty string if not found
  address: string;        // always present
  _hasBoth: boolean;      // internal sort key — NOT exported
  _qualityTier: QualityTier; // internal — NOT exported, NOT in SSE payloads
}

interface RawLead {
  name: string;           // from Google Maps card
  address: string;        // from Google Maps card
  rawPhone: string;       // raw, not yet normalised
  website: string;        // normalised URL (https://, no trailing slash)
  placeId: string;        // synthetic ID for logging
}

interface FailureMetrics {
  discard_no_contact: number;
  website_unreachable: number;
  email_not_found: number;
  phone_not_found: number;
  duplicate_skipped: number;
  captcha_blocked: number;
}
```
