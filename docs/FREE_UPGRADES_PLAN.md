# FREE Upgrades Plan

> **Scope:** $0-cost upgrades only. No paid APIs, no paid tools, no infrastructure changes.
> All upgrades extend existing modules without modifying the core pipeline architecture.
> The pipeline orchestrator (`pipeline.ts`) is not modified.
>
> **Status: ✅ ALL 10 UPGRADES IMPLEMENTED — 245/245 tests passing**

---

## Upgrades in Scope

| # | Upgrade | Phase | Status |
|---|---------|-------|--------|
| 1 | JSON-LD structured data extraction (emails, phones, address) | A | ✅ Done |
| 2 | Email validation — syntax + MX record check | A | ✅ Done |
| 3 | DNS pre-resolution (skip dead domains before scraping) | B | ✅ Done |
| 4 | Static-first detection heuristics (Cheerio vs Playwright) | B | ✅ Done |
| 5 | Retry logic — max 2 retries, exponential backoff, timeout/5xx only | B | ✅ Done |
| 6 | Multi-keyword batching | C | ✅ Done |
| 7 | Multi-location batching | C | ✅ Done |
| 8 | Increase MAX_LEADS_PER_RUN to 200 (configurable) | C | ✅ Done |
| 9 | Improved in-depth crawl — scored link priority, max 5 pages | D | ✅ Done |
| 10 | Contact form detection — flag only, no email guessing | D | ✅ Done |

---

## Rules

- Do NOT modify `pipeline/pipeline.ts`
- Do NOT modify the core pipeline flow or step ordering
- Do NOT add new npm dependencies unless strictly necessary
- Extend existing modules only — new functions alongside existing ones
- All new env vars have safe defaults so existing behaviour is unchanged

---

## Phase A — Extraction & Quality ✅ COMPLETE

### A1. JSON-LD Structured Data Extraction ✅

**File:** `backend/src/pipeline/emailExtractor.ts`
**Also affects:** `backend/src/pipeline/phoneNormalizer.ts`

Many business websites embed `<script type="application/ld+json">` blocks with
`LocalBusiness`, `Organization`, or `ContactPoint` schema. These are more reliable
than regex on visible text and often contain contacts that the current extractor misses.

**What to add:**

Add a new function `extractFromJsonLd(html: string)` that:
1. Finds all `<script type="application/ld+json">` tags using Cheerio
2. Parses each block with `JSON.parse()` inside a try/catch
3. Walks the parsed object looking for these schema types:
   - `LocalBusiness`, `Organization`, `MedicalBusiness`, `ProfessionalService`
   - `ContactPoint` (nested under `contactPoint` or `contactPoints`)
4. Extracts:
   - `email` field → candidate email string
   - `telephone` field → candidate phone string
   - `address.streetAddress` + `address.addressLocality` → candidate address string
5. Returns `{ email: string, phone: string, address: string }` — empty strings if not found

**Integration in `extractEmail()`:**
- Call `extractFromJsonLd(html)` at the top of `extractEmail()`, before the existing
  mailto + regex pipeline
- If a JSON-LD email is found, push it into the `mailtoEmails` array (highest priority)
- It still passes through the existing blacklist and noise filters — no special casing

**Integration in `extractPhone()`:**
- Call `extractFromJsonLd(html)` inside `extractPhone()`, after the discovery phone check
  and before the regex scan of page text
- If a JSON-LD phone is found, try `normalisePhone(jsonLdPhone, isoCode)` first
- If valid, return it immediately (same priority as discovery phone from website)

**No new dependencies needed** — Cheerio is already imported in `emailExtractor.ts`.
`JSON.parse` is built-in.

**Expected yield improvement:** +15–25% more emails found per run, especially for
WordPress, Squarespace, and Wix sites that auto-generate schema markup.

---

### A2. Email Validation — Syntax + MX Record Check ✅

**File:** `backend/src/pipeline/emailExtractor.ts`

After the existing noise filter (Step 5), add a lightweight two-step validation that
filters emails whose domain cannot receive mail. This does NOT violate Constraint #3
(no bounce verification) — no SMTP connection is made.

**What to add:**

Add a new async function `isEmailDomainValid(email: string): Promise<boolean>` that:
1. **Syntax check:** Verify the email matches a strict RFC 5322 pattern:
   `/^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/`
   Return `false` immediately if it fails.
2. **MX record check:** Call `dns.resolveMx(domain)` from Node's built-in `dns/promises`
   module. Return `true` if at least one MX record exists. Return `false` if the DNS
   lookup throws (ENOTFOUND, ENODATA, timeout).
3. Cache results in a `Map<string, boolean>` keyed by domain — avoids re-querying the
   same domain multiple times within a run.

**Integration in `extractEmail()`:**
- After Step 5 (noise filter), run `isEmailDomainValid()` on each surviving candidate
- Filter out candidates that return `false`
- The rest of the ranking logic (Step 6) runs on the validated set
- If the validated set is empty, fall through to `email_not_found` as before

**No new dependencies needed** — `dns/promises` is a Node.js built-in.

**Expected improvement:** Eliminates emails from expired domains, placeholder sites,
and misconfigured mail servers — reduces bounce rate on outreach campaigns.

---

## Phase B — Performance ✅ COMPLETE

### B1. DNS Pre-Resolution ✅

**File:** `backend/src/pipeline/scraper.ts`

Before launching Playwright or Cheerio for a batch of websites, resolve all hostnames
in parallel. Domains that fail DNS lookup are marked `website_unreachable` immediately
without opening a browser page.

**What to add:**

Add a new exported async function `preResolveDns(urls: string[]): Promise<Set<string>>`
that:
1. Extracts the hostname from each URL using `new URL(url).hostname`
2. Calls `dns.resolve(hostname)` (from `dns/promises`) for all hostnames in parallel
   using `Promise.allSettled()`
3. Returns a `Set<string>` of hostnames that **failed** DNS resolution
   (status `'rejected'` in the `allSettled` result)

**Integration in `pipeline.ts`:**
> The pipeline orchestrator is not modified. Instead, modify `scrapePage()` in
> `scraper.ts` to accept an optional pre-resolved dead-set parameter, OR add the
> DNS check inside `scrapePage()` itself before calling `detectPageType()`.

Preferred approach — add inside `scrapePage()`:
```typescript
// At the top of scrapePage(), before isAllowedByRobots():
const hostname = new URL(url).hostname;
try {
  await dns.resolve(hostname);
} catch {
  return markUnreachable(url, 'DNS resolution failed');
}
```

This keeps `pipeline.ts` unchanged. The DNS check adds ~50–200ms per dead domain
but saves the full `GLOBAL_SITE_TIMEOUT_MS` (12s) that would otherwise be wasted.

**No new dependencies needed** — `dns/promises` is a Node.js built-in.

**Expected improvement:** Saves ~8–12s per dead domain. Common for old Google Maps
listings pointing to expired domains (~5–15% of results in some regions).

---

### B2. Static-First Detection Heuristics ✅

**File:** `backend/src/pipeline/detect.ts`

Before making a network request, classify the URL based on known hosting platform
patterns. This saves the detection fetch for ambiguous cases.

**What to add:**

Add two lookup maps at the top of `detect.ts`:

```typescript
// Domains/patterns that are always static — use Cheerio directly
const ALWAYS_STATIC_PATTERNS: string[] = [
  'github.io',
  'netlify.app',
  'pages.dev',       // Cloudflare Pages
  'surge.sh',
  'tiiny.site',
];

// Domains/patterns that are always dynamic — use Playwright directly
const ALWAYS_DYNAMIC_PATTERNS: string[] = [
  'myshopify.com',
  'squarespace.com',
  'webflow.io',
  'wixsite.com',
  'weebly.com',
  'godaddysites.com',
  'sites.google.com',
];
```

Add a new function `getHeuristicPageType(url: string): PageType | null` that:
1. Extracts the hostname from the URL
2. Checks if the hostname ends with any `ALWAYS_STATIC_PATTERNS` entry → return `'static'`
3. Checks if the hostname contains any `ALWAYS_DYNAMIC_PATTERNS` entry → return `'dynamic'`
4. Returns `null` if no match (proceed with normal network detection)

**Integration in `detectPageType()`:**
- Call `getHeuristicPageType(url)` at the very top of `detectPageType()`
- If it returns `'static'`: skip the fetch, return `{ pageType: 'static', html: '' }`
  (the scraper will then do a Cheerio fetch — this is the existing static path)
- If it returns `'dynamic'`: skip the fetch, return `{ pageType: 'dynamic', html: '' }`
- If it returns `null`: proceed with the existing network-based detection

**Note:** When heuristic returns `'static'` with empty HTML, `scraper.ts` will call
`scrapeDynamic()` as a fallback (existing behaviour for empty static HTML). This is
acceptable — the heuristic saves the detection fetch, not the scrape itself.

**No new dependencies needed.**

**Expected improvement:** Saves the 1–3s detection fetch for ~10–20% of URLs that
match known patterns. Reduces false-dynamic classifications for known static hosts.

---

### B3. Retry Logic — Exponential Backoff ✅

**File:** `backend/src/pipeline/scraper.ts`

Currently, a failed scrape is immediately marked `website_unreachable`. Adding a retry
loop recovers transient failures (brief server overload, flaky connections, CDN hiccups).

**What to add:**

Add a new helper `withRetry<T>(fn: () => Promise<T>, maxRetries: number, baseDelayMs: number): Promise<T>`
that:
1. Calls `fn()`
2. If it throws or returns an unreachable result, waits `baseDelayMs * 2^attempt` ms
3. Retries up to `maxRetries` times
4. Returns the last result (success or final failure) after all retries are exhausted

**Retry conditions (only retry on):**
- `ScrapeResult.unreachable === true` AND the failure reason contains `'timeout'`
  or `'HTTP 5'` (5xx status codes)
- Do NOT retry on: `HTTP 4xx`, `login redirect`, `DNS failed`, `robots.txt disallowed`

**Configuration via env vars (with safe defaults):**
```env
SCRAPE_MAX_RETRIES=2          # default: 2 (0 = disabled, preserves current behaviour)
SCRAPE_RETRY_BASE_DELAY_MS=2000  # default: 2000ms → backoff: 2s, 4s
```

**Integration in `scrapePage()`:**
- Wrap the `detectPageType()` + `scrapeStatic()` / `scrapeDynamic()` call block
  in the retry helper
- The robots.txt check and DNS check (B1) run BEFORE the retry loop — no point
  retrying a robots-disallowed or DNS-dead URL

**No new dependencies needed.**

**Expected improvement:** Recovers ~5–10% of currently-unreachable sites. Particularly
effective for shared hosting and small business sites with intermittent availability.

---

## Phase C — Yield Increase ✅ COMPLETE

### C1. Multi-Keyword Batching ✅

**Files:**
- `backend/src/routes/start.ts` — accept `keywords: string[]` alongside existing `keyword: string`
- `backend/src/pipeline/pipeline.ts` — **NOT modified**
- `frontend/src/components/InputPanel.tsx` — add keyword tag input
- `frontend/src/app/page.tsx` — pass keywords array to start handler

**What to add:**

**Backend (`routes/start.ts`):**
- Accept either `keyword: string` (existing, single) or `keywords: string[]` (new, multiple)
- Normalise to an array: `const keywordList = keywords ?? (keyword ? [keyword] : [])`
- Validate: at least 1 keyword, max 5 keywords, each non-empty string
- Run `runPipeline()` sequentially for each keyword with the same location and jobId
- The dedup Set in `store` persists across all keyword runs within the same job
  (it is only cleared on `store.reset()`, which is called once at job start)
- SSE events stream continuously — the frontend sees leads from all keywords in real time

**Frontend (`InputPanel.tsx`):**
- Add a tag-style input below the keyword field: type a keyword and press Enter or comma
  to add it as a chip; click a chip's × to remove it
- Show the existing single keyword input as the first chip slot
- Pass `keywords: string[]` to `onStart`

**No new backend dependencies needed.** Frontend uses React state only.

**Expected yield:** 2–3× more leads per run. Example: `dental clinic`, `dentist`,
`orthodontist` in `London, UK` → ~150–240 leads vs ~50–80 from a single keyword.

---

### C2. Multi-Location Batching ✅

**Files:**
- `backend/src/routes/start.ts` — accept `locations: string[]` alongside existing `location: string`
- `backend/src/pipeline/pipeline.ts` — **NOT modified**
- `frontend/src/components/InputPanel.tsx` — add location tag input
- `frontend/src/app/page.tsx` — pass locations array to start handler

**What to add:**

**Backend (`routes/start.ts`):**
- Accept either `location: string` (existing) or `locations: string[]` (new)
- Normalise to an array: `const locationList = locations ?? (location ? [location] : [])`
- Validate: at least 1 location, max 5 locations
- Geocode each location sequentially before starting any scraping
  (fail fast if any location is invalid — return error to UI before job starts)
- Run `runPipeline()` sequentially for each location with the same keyword and jobId
- The dedup Set persists across all location runs — prevents the same business
  appearing twice if it has branches in multiple cities
- SSE streams continuously across all location runs

**Frontend (`InputPanel.tsx`):**
- Same tag-style input pattern as C1, applied to the location field
- Show a note: "Up to 5 locations. Each is scraped sequentially."

**No new backend dependencies needed.**

**Expected yield:** 2–5× more leads per run. Example: `dental clinic` across
`London`, `Manchester`, `Birmingham` → ~150–240 leads vs ~50–80 from one city.

---

### C3. Increase MAX_LEADS_PER_RUN to 200 (Configurable) ✅

**File:** `backend/.env` and `backend/.env.example`

The `MAX_LEADS_PER_RUN` env var already exists and is read in `discovery.ts`:
```typescript
const MAX_LEADS = parseInt(process.env.MAX_LEADS_PER_RUN ?? '100', 10);
```

**Change:**
- Update the default in `.env` and `.env.example` from `100` to `200`
- Add a comment in `.env.example` explaining the tradeoff:

```env
# Max raw leads to discover per job per keyword+location combination.
# Google Maps can return 200-300+ results for popular categories in large cities.
# Higher values = more leads but longer discovery time and higher CAPTCHA risk.
# Recommended range: 100-300. Default: 200.
MAX_LEADS_PER_RUN=200
```

**No code changes needed** — the env var is already wired. This is a config-only change.

**Expected yield:** ~100–160 qualified leads per run instead of ~50–80.

---

## Phase D — Crawl Improvements ✅ COMPLETE

### D1. Improved In-Depth Crawl — Scored Link Priority, Max 5 Pages ✅

**File:** `backend/src/pipeline/scraper.ts` (function `extractContactSubPageUrls`)
**Also:** `backend/src/pipeline/indepth.ts` (constant `MAX_SUBPAGES`)

**Current behaviour:**
`extractContactSubPageUrls()` matches links by URL path pattern only
(`/contact`, `/about`, `/team`, etc.) and returns up to 4 results in DOM order.

**What to change:**

**In `scraper.ts` — replace `extractContactSubPageUrls()`:**

Add a scoring system that ranks matched links by relevance before returning them.
Score each matched link by:

| Signal | Points |
|--------|--------|
| URL path contains `contact` | +30 |
| URL path contains `about` | +20 |
| URL path contains `team` or `staff` | +15 |
| URL path contains `leadership` | +10 |
| Anchor text contains `contact` (case-insensitive) | +25 |
| Anchor text contains `email` or `reach` or `get in touch` | +20 |
| Anchor text contains `about` | +15 |
| Anchor text contains `team` or `people` | +10 |

Return links sorted by score descending. Higher-scoring links (most likely to have
contact info) are scraped first, so even if the max page cap is hit, the best pages
were already scraped.

Also expand the URL pattern list to catch more contact pages:
```typescript
const CONTACT_PATTERNS = [
  '/contact', '/contact-us', '/contacts', '/reach-us', '/get-in-touch',
  '/about', '/about-us', '/our-team', '/team', '/staff', '/people',
  '/leadership', '/management', '/founders', '/meet-the-team',
];
```

**In `indepth.ts` — increase `MAX_SUBPAGES`:**
```typescript
// Was: const MAX_SUBPAGES = 3;
const MAX_SUBPAGES = parseInt(process.env.INDEPTH_MAX_SUBPAGES ?? '5', 10);
```

Add `INDEPTH_MAX_SUBPAGES` to `.env.example`:
```env
# Max sub-pages to scrape per lead in in-depth mode (homepage not counted).
# Higher = more email yield, slower run. Default: 5. Max recommended: 8.
INDEPTH_MAX_SUBPAGES=5
```

**No new dependencies needed** — Cheerio is already used in `extractContactSubPageUrls()`.

**Expected improvement:** +10–20% more emails found on in-depth runs. The scoring
ensures the most valuable pages are always scraped even when the cap is hit.

---

### D2. Contact Form Detection — Flag Only ✅

**File:** `backend/src/pipeline/emailExtractor.ts`
**Also:** `backend/src/types.ts`, `backend/src/pipeline/filter.ts`, `backend/src/exporter.ts`

When no email is found but a contact form exists, flag the lead with `hasContactForm: true`.
This prevents outreach teams from ignoring leads that have a reachable contact method —
just not a scraped email address. **No email is guessed. No constraint is violated.**

**What to add:**

**`emailExtractor.ts` — new function `detectContactForm(html: string): boolean`:**
1. Load HTML with Cheerio
2. Look for `<form>` elements that contain at least two of these field name/id patterns:
   - `name`, `email`, `message`, `subject`, `phone`, `enquiry`, `inquiry`, `contact`
3. Also check for common contact form plugin markers:
   - `class` containing `wpcf7`, `contact-form`, `gform`, `wpforms`, `ninja-forms`
   - `id` containing `contact`, `enquiry`, `inquiry`
4. Return `true` if any match is found, `false` otherwise

**`types.ts` — add field to `Lead` interface:**
```typescript
/**
 * True if a contact form was detected on the website but no email was scraped.
 * Informational only — never used for filtering. NOT a constraint violation.
 */
hasContactForm?: boolean;
```

**`filter.ts` — set the flag:**
- After `extractEmail()` returns empty string, call `detectContactForm(html)`
- Set `lead.hasContactForm = true` if detected
- The existing filter logic (`email || phone` check) is unchanged — a lead with
  `hasContactForm: true` but no email still passes if it has a phone number

**`exporter.ts` — add column:**
- Add a "Contact Form" column (values: `"Yes"` / `""`) after the Website column
- Only populated when `lead.hasContactForm === true`

**No new dependencies needed** — Cheerio is already imported in `emailExtractor.ts`.

---

## Implementation Order Summary ✅ ALL COMPLETE

```
Phase A  (Extraction & Quality)  ✅
  A1  JSON-LD extraction          → emailExtractor.ts, phoneNormalizer.ts
  A2  Email MX validation         → emailExtractor.ts

Phase B  (Performance)  ✅
  B1  DNS pre-resolution          → scraper.ts
  B2  Static-first heuristics     → detect.ts
  B3  Retry with backoff          → scraper.ts

Phase C  (Yield Increase)  ✅
  C1  Multi-keyword batching      → routes/start.ts, InputPanel.tsx
  C2  Multi-location batching     → routes/start.ts, InputPanel.tsx
  C3  Raise MAX_LEADS_PER_RUN     → .env, .env.example  (config only)

Phase D  (Crawl Improvements)  ✅
  D1  Improved in-depth crawl     → scraper.ts, indepth.ts
  D2  Contact form detection      → emailExtractor.ts, types.ts, filter.ts, exporter.ts
```

---

## Files Changed Per Upgrade

| Upgrade | Files Modified | New Files |
|---------|---------------|-----------|
| A1 JSON-LD extraction | `emailExtractor.ts`, `phoneNormalizer.ts` | — |
| A2 Email MX validation | `emailExtractor.ts` | — |
| B1 DNS pre-resolution | `scraper.ts` | — |
| B2 Static-first heuristics | `detect.ts` | — |
| B3 Retry logic | `scraper.ts` | — |
| C1 Multi-keyword batching | `routes/start.ts`, `InputPanel.tsx`, `page.tsx` | — |
| C2 Multi-location batching | `routes/start.ts`, `InputPanel.tsx`, `page.tsx` | — |
| C3 Raise MAX_LEADS_PER_RUN | `.env`, `.env.example` | — |
| D1 Improved in-depth crawl | `scraper.ts`, `indepth.ts`, `.env.example` | — |
| D2 Contact form detection | `emailExtractor.ts`, `types.ts`, `filter.ts`, `exporter.ts` | — |

**`pipeline/pipeline.ts` is not modified by any upgrade.**

---

## Expected Outcomes

| Metric | Current | After All Upgrades |
|--------|---------|-------------------|
| Qualified leads per single run | ~50–80 | ~80–120 |
| Qualified leads with multi-keyword (3 keywords) | ~50–80 | ~200–350 |
| Qualified leads with multi-location (3 cities) | ~50–80 | ~200–350 |
| Email extraction rate | ~30–50% | ~45–65% |
| Dead-domain scrape time wasted | ~8–12s/domain | ~0.2s/domain |
| In-depth email yield | baseline | +10–20% |
| Leads with contact form flagged | 0 | ~10–20% of no-email leads |

---

*All upgrades are $0 cost. No paid APIs. No new infrastructure.*

---

## Implementation Result

**Completed:** May 2026  
**Tests:** 245/245 passing (was 233 before upgrades — 12 new tests added)  
**TypeScript:** 0 errors on both backend and frontend  
**pipeline.ts:** Not modified ✅
