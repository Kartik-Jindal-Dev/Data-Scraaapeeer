# Speed Optimization Options

> Current baseline: ~3–5 minutes for 48 leads (homepage), ~8–15 minutes for in-depth.
> This document covers every lever available, from zero-cost config changes to paid services.

---

## Where the Time Goes (Bottleneck Analysis)

| Stage | Time per run | Bottleneck |
|-------|-------------|------------|
| Discovery (Google Maps) | 1–3 min | 1s delay × 48 place navigations, sequential |
| Website scraping — static (Cheerio) | ~0.5s/site | Network RTT only, fast |
| Website scraping — dynamic (Playwright) | 5–20s/site | Browser launch + JS render + 20s global timeout |
| In-depth crawl | 3× website scraping | 3 extra pages per lead |
| Email/phone extraction | <0.1s/lead | CPU only, negligible |

**The two killers are:**
1. Discovery navigating to each place URL individually (48 page loads)
2. Dynamic website scraping with a 20s timeout per site, even with 5x concurrency

---

## Tier 1 — Free (Config Changes Only)

These require no code changes and no money. Do these first.

### 1.1 Reduce discovery delay ✅ IMPLEMENTED

In `backend/.env`:
```env
REQUEST_DELAY_MS=500
REQUEST_DELAY_JITTER_MS=200
```
Current default is 1000ms + 500ms jitter. Halving it cuts discovery time by ~40%.
Risk: slightly higher chance of a temporary Google block. Recovers on retry.

### 1.2 Increase scraping concurrency ✅ IMPLEMENTED

In `backend/.env`:
```env
SCRAPE_CONCURRENCY=10
```
Current default is 5. Doubling it halves the website scraping phase.
Risk: more simultaneous outbound connections — some sites may rate-limit you.

### 1.3 Reduce dynamic page timeout ✅ IMPLEMENTED

Timeouts are now env-configurable in `backend/.env`:
```env
PLAYWRIGHT_LOAD_TIMEOUT_MS=8000   # was 15000
GLOBAL_SITE_TIMEOUT_MS=12000      # was 20000
```
Most real business sites load in under 5s. The old 20s timeout was wasted waiting for
slow/dead sites. Cutting it to 12s saves up to 8s per slow site.

### 1.4 Skip robots.txt check ✅ IMPLEMENTED

In `backend/.env`:
```env
RESPECT_ROBOTS_TXT=false
```
Each robots.txt check is an extra HTTP request per domain. Disabling it saves
~0.2–0.5s per site with a website. For 40 sites that's 8–20 seconds.

### 1.5 Reduce MAX_LEADS_PER_RUN

In `backend/.env`:
```env
MAX_LEADS_PER_RUN=30
```
If you only need 25–30 qualified leads, don't scrape 100. Fewer leads = proportionally faster.

**Combined free savings: ~40–60% faster with no code changes.**

---

## Tier 2 — Free (Code Changes)

These require code modifications but cost nothing.

### 2.1 Extract data from the Maps list directly (no per-place navigation) ✅ IMPLEMENTED

**Biggest single win available for free.**

Previously discovery navigated to each place's detail URL individually (48 page loads).
Google Maps renders name, address, phone, and website directly in the search results list.
The new implementation extracts from the list first — only falling back to per-place
navigation for results missing both phone AND website (~20–30% of results).

Estimated saving: **60–80% fewer page navigations during discovery**.

Implementation: `backend/src/pipeline/discovery.ts` — `extractFromList()` + `extractFromDetailPanel()` fallback.

### 2.2 Parallel discovery + scraping pipeline (streaming) ✅ IMPLEMENTED

Previously the pipeline was fully sequential: finish all discovery → then scrape all websites.
The new streaming pipeline processes each batch of leads through scrape → extract → filter → SSE
immediately after scraping, without waiting for all leads to be scraped first.

Result: **first leads appear in the UI within seconds of discovery completing**.

Implementation: `backend/src/pipeline/pipeline.ts` — single batch loop combining steps 4–7.

### 2.3 Reuse a single Playwright page for dynamic scraping (page pool) ✅ IMPLEMENTED

Previously each dynamic site opened a new page in the shared context. A pool of persistent
pages (pre-navigated to `about:blank`) eliminates the page creation overhead.

Pool size = `SCRAPE_CONCURRENCY` (default 10). Pages are checked out, used, and returned.
Errored pages are discarded and replaced automatically.

Estimated saving: ~0.3–0.5s per dynamic site.

Implementation: `backend/src/pipeline/scraper.ts` — `checkoutPage()` / `returnPage()` pool.

### 2.4 Smarter static detection — 1s timeout instead of 2s ✅ IMPLEMENTED

Detection timeout reduced from 2s to 1s (configurable via `DETECTION_TIMEOUT_MS` env var).
Most static sites respond in <500ms. Saves ~1s per static site.

Implementation: `backend/src/pipeline/detect.ts` — `DETECTION_TIMEOUT_MS` env-configurable.

### 2.5 Cache robots.txt results across runs (persistent file cache)

Currently the robots.txt cache is in-memory and cleared on restart. A simple JSON file
cache means repeat runs against the same domains skip the robots.txt fetch entirely.
Not implemented — `RESPECT_ROBOTS_TXT=false` is the simpler solution for now.

---

## Tier 3 — Freemium (Free Tier Available, Paid for Scale)

### 3.1 Outscraper API — Google Maps data without Playwright

**Website:** https://outscraper.com  
**Free tier:** 500 records/month  
**Paid:** ~$3 per 1,000 records (~$0.15 for a 50-lead run)

Outscraper returns name, address, phone, website, and more in a single API call —
no browser, no scrolling, no clicking. Discovery drops from 1–3 minutes to ~5 seconds.

This is the single highest-impact change available. It was the original Phase 1 design
before the free-stack switch.

```typescript
const res = await fetch(
  `https://api.app.outscraper.com/maps/search?query=${encodeURIComponent(keyword + ' ' + location)}&limit=100&async=false`,
  { headers: { 'X-API-KEY': process.env.OUTSCRAPER_API_KEY! } }
);
const data = await res.json();
```

### 3.2 ScrapingBee / Apify — managed browser scraping

**ScrapingBee:** https://scrapingbee.com — 1,000 free API credits/month  
**Apify:** https://apify.com — $5/month free tier

Replace the Playwright website scraper with an API call. No local browser overhead,
no timeout management, no stealth plugin needed. Each page fetch is a single HTTP request.

Best for: replacing the dynamic Playwright scraper for business websites.
Not suitable for Google Maps discovery (they block Maps scraping).

### 3.3 Bright Data Web Scraper IDE

**Website:** https://brightdata.com  
**Free trial:** available  
**Paid:** ~$0.001 per page

Managed scraping infrastructure with built-in proxy rotation and CAPTCHA solving.
Eliminates all anti-blocking concerns.

---

## Tier 4 — Paid (Best Performance)

### 4.1 Google Places API (New)

**Website:** https://developers.google.com/maps/documentation/places/web-service  
**Cost:** $0.017 per Text Search request (returns up to 20 results)  
**For 100 leads:** ~5 requests = ~$0.085 per run

Returns structured JSON with name, address, phone, website, hours, rating.
Discovery becomes a pure API call — no browser, no scrolling, ~1 second total.

```typescript
const res = await fetch(
  `https://places.googleapis.com/v1/places:searchText`,
  {
    method: 'POST',
    headers: {
      'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY!,
      'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ textQuery: `${keyword} in ${location}`, maxResultCount: 20 }),
  }
);
```

### 4.2 Residential proxy rotation

**Providers:** Bright Data, Oxylabs, Smartproxy  
**Cost:** ~$3–8/month for 1GB  

Eliminates CAPTCHA and block risk entirely for Google Maps scraping.
Combine with the free Playwright approach for near-zero block rate.

### 4.3 Dedicated scraping VPS (faster hardware)

Running Playwright on a VPS with 4+ cores and 8GB RAM is significantly faster than
a local dev machine sharing resources. A $6/month Hetzner CX22 or DigitalOcean Droplet
handles 10+ concurrent Playwright pages without slowdown.

---

## Recommended Action Plan

### If you want free improvements today (30 min of work):

1. Set `REQUEST_DELAY_MS=500` and `SCRAPE_CONCURRENCY=10` in `.env`
2. Reduce timeouts in `scraper.ts` to 8s/12s
3. Set `RESPECT_ROBOTS_TXT=false`

**Expected result:** ~2× faster, no code changes.

### If you want the biggest single improvement (2–3 hours of work):

Implement **inline list extraction** (Tier 2.1) to skip per-place navigation.
This is the highest-ROI free code change.

### If you want production-grade speed (~$1–2/run):

Add **Outscraper API** as the discovery source (Tier 3.1) with Playwright as fallback.
Discovery goes from 1–3 minutes to 5 seconds. This was the original blueprint design.

### If you want near-instant results (~$0.10/run):

Use **Google Places API** (Tier 4.1) for discovery + ScrapingBee (Tier 3.2) for website
scraping. Total run time drops to under 60 seconds for 50 leads.

---

## Current Timing Reference

| Configuration | Discovery | Website Scraping | Total (50 leads) |
|--------------|-----------|-----------------|-----------------|
| Original baseline | ~2–3 min | ~3–5 min | ~5–8 min |
| ✅ Tier 1 only (config) | ~1.5 min | ~1.5–2 min | ~3–4 min |
| ✅ Tier 1 + Tier 2 (current) | ~20–40s | ~45–90s | **~1–2 min** |
| + Outscraper API (Tier 3.1) | ~5s | ~45–90s | ~1 min |
| + Google Places + ScrapingBee | ~5s | ~30s | ~35s |
