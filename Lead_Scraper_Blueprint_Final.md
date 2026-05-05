# Lead-Generation Scraper — Implementation Blueprint

**Purpose:** In-house lead generation for email marketing and cold-calling teams.
**Output:** Filtered, sorted Excel file of businesses with at least one contact method (email or phone).
**Scope:** ~100 leads per run, global coverage, public data only.

---

## Table of Contents

1. [Requirements & Scope](#1-requirements--scope)
2. [System Architecture](#2-system-architecture)
3. [Data Pipeline & Flow](#3-data-pipeline--flow)
4. [Lead Discovery](#4-lead-discovery)
5. [Website Extraction & Enrichment](#5-website-extraction--enrichment)
6. [Data Model & Output](#6-data-model--output)
7. [Front-End Dashboard](#7-front-end-dashboard)
8. [Tools & Technology Stack](#8-tools--technology-stack)
9. [Anti-Blocking & Reliability](#9-anti-blocking--reliability)
10. [Compliance & Ethical Considerations](#10-compliance--ethical-considerations)
11. [Operational Runbook & Monitoring](#11-operational-runbook--monitoring)
12. [Testing & Quality Assurance](#12-testing--quality-assurance)
13. [Setup & Execution Guide](#13-setup--execution-guide)
14. [Phased Build Plan](#14-phased-build-plan)
15. [Assumptions & Open Questions](#15-assumptions--open-questions)
16. [References & Resources](#16-references--resources)

---

## 1. Requirements & Scope

### 1.1 Inputs

| Input | Example | Notes |
|-------|---------|-------|
| Keyword | "digital marketing agency" | Business category or type |
| Location | "Noida, India" / "Paris, France" | City, state, country, or region |
| Depth | Homepage / In-depth | Controls how deep website scraping goes |

Location is validated via Geocoding API before the job starts. Invalid locations return an error immediately — no wasted scrape runs.

### 1.2 Output Fields

| Field | Required? | Rule |
|-------|-----------|------|
| Business Name | Always | Sourced from discovery (Outscraper / Maps) |
| Email | Conditional | Required if Phone is absent |
| Phone | Conditional | Required if Email is absent |
| Website | Optional | Include URL if found; blank if not |
| Address | Always | Sourced from discovery |

**Filter rule:** Any lead with no email AND no phone after all scraping steps is discarded. It will not appear in the export. The discard count is shown in the UI.

**Sort rule:** In the Excel export, leads with both email AND phone appear first (green-highlighted rows), followed by leads with only one contact method.

### 1.3 Constraints

- **No email guessing.** Only actual scraped emails are used. No domain-pattern generation.
- **No storage.** Data lives in memory for the current session only. Restarting the server clears it. Export before stopping the server.
- **No bounce verification.** Emails are not validated for deliverability.
- **Phone format:** E.164 international format (`+919876543210`, `+12025551234`). ISO country code is derived from the location input and used as the default region for normalization.
- **Volume:** ~100 raw leads per run. After filtering, expect 50–80 qualifying leads depending on industry and region.
- **Geography:** Worldwide. Single-location queries per run.
- **Export:** Excel (.xlsx) only. One button. No format choices, no field picker.
- **Deployment:** Local machine or VPS. Vercel serverless is not suitable (headless browsers need persistent processes).
- **Budget:** Free-tier tools throughout. Up to $5–6/month acceptable for Outscraper overage or a proxy if persistent blocks occur.

---

## 2. System Architecture

The system is a modular, pipeline-driven architecture. The frontend sends a job request; the backend discovers, scrapes, filters, and streams results back live. No database is involved.

```mermaid
flowchart TD
    UI[Next.js Dashboard] -->|keyword + location + depth| API[Express API - Node.js]
    API -->|geocode validate| GeoCheck{Location valid?}
    GeoCheck -->|No| UIError[Error to UI]
    GeoCheck -->|Yes| Queue((Crawlee RequestQueue))
    Queue --> Discovery[Outscraper API primary\nPlaywright Maps fallback]
    Discovery --> RawList[Raw Business List — all kept]
    RawList --> Dedup[Dedup - in-memory Set\nkey: normalizedPhone|rootDomain via tldts]
    Dedup --> DetailQueue((Detail Scrape Queue))
    DetailQueue --> StaticCheck{Static page?\nno React/Vue/Next markers\nfast load}
    StaticCheck -->|Yes| Cheerio[Cheerio parse]
    StaticCheck -->|No| Playwright[Playwright fetch]
    Cheerio --> PhoneNorm[Phone normalization]
    Playwright --> PhoneNorm
    PhoneNorm --> EmailExtract[Email extraction + hardened filter]
    EmailExtract --> Filter{email OR phone\npresent?}
    Filter -->|No| Discard[Discard + log + SSE discard event\n+ failure metrics counter]
    Filter -->|Yes| QualityTier[Assign quality tier\nTier1/Tier2/Tier3]
    QualityTier --> MemArray[In-memory leads array]
    MemArray -->|SSE lead event via tracked connection| UI
    MemArray -->|Export click| Sort[Sort: both-contact first]
    Sort --> Excel[exceljs - .xlsx download\nstreaming writer if >500]
    API -->|/api/stop| StopHandler[Drain queue 10s hard timeout\nForce close browser contexts\nPreserve array]
```

### Components

**Next.js Dashboard (UI)**
Provides keyword/location input, depth toggle, Start/Stop controls, a live-updating results table driven by SSE, a discard counter, and a single Export to Excel button.

**Express API (Backend)**
Handles all endpoints: `/api/start`, `/api/stop`, `/api/status`, `/api/stream` (SSE), `/api/export`. Validates location before starting any scrape work.

**Crawlee RequestQueue**
OSS framework by Apify. Wraps Playwright with built-in concurrency control, retry logic, and request fingerprint rotation. Replaces all custom queue and retry boilerplate.

**Discovery Module**
Calls Outscraper API (primary). If quota is exhausted or the call fails, automatically falls back to Playwright navigating Google Maps. Returns a raw list of businesses with name, address, phone, and website.

**Deduplicator**
In-memory `Set<string>` per job. Key is `normalizedPhone|rootDomain` where root domain is extracted via `tldts` (handles subdomains, multi-part TLDs like `.co.uk` correctly). Skips any entry already seen in this run before it reaches the detail scraping queue.

**Detail Scraper**
Before launching Playwright, performs a lightweight static-detection check: sends a HEAD + quick GET request and inspects for JS framework markers (`react`, `vue`, `next`, `__NEXT_DATA__`, `ng-version`). If the page is static (no markers, fast load <2s), uses Cheerio for speed. Otherwise uses Playwright with `waitUntil: 'networkidle'`. Extracts email and phone only.

**Filter**
Runs ONLY after ALL scraping steps complete (discovery + website scraping + phone normalization + email extraction). No leads are discarded during the discovery stage. Checks `lead.email || lead.phone`. If both are empty, the lead is discarded (logged, counted via failure metrics, SSE event emitted). It never reaches the export.

**In-Memory `leads[]` Array**
Single source of truth for the session. TypeScript array of `Lead` objects. Cleared on `resetJob()` at the start of each new job. No file writes, no DB.

**SSE Endpoint (`GET /api/stream`)**
Server pushes each qualified lead as a `lead` event immediately. Also emits `discard`, `status`, and `error` events. Frontend `EventSource` consumes these and updates the UI without polling. SSE connections are tracked per `jobId` — a new connection automatically closes any previous connection for the same job. Connections are also closed on job stop and job completion to prevent memory leaks.

**Stop Handler**
On `POST /api/stop`: signals Crawlee to stop accepting new requests, waits for in-flight pages to finish with a **hard timeout of 10 seconds**. After timeout, **force-closes all Playwright browser contexts** regardless of in-flight state. Sets job status to `stopped`. The `leads[]` array is preserved — export still works.

**Exporter**
`GET /api/export`: sorts `leads[]` (both-contact leads first), generates `.xlsx` via `exceljs` with header styling and green row highlights for Tier 1 leads, streams the buffer as a file download. Internally structured to support a streaming writer path when `leads.length > 500` for scalability (no UI change).

---

## 3. Data Pipeline & Flow

```mermaid
flowchart LR
    subgraph INPUT
      IN[Keyword + Location]
    end
    IN --> GeoValidate[Geocode + extract ISO country code\nretry with cleaned query on failure]
    GeoValidate -->|invalid after retry| EarlyExit[Return error to UI]
    GeoValidate -->|valid| Discovery[Outscraper API\nor Playwright Maps]
    Discovery --> RawList[Up to 100 raw businesses — all kept]
    RawList --> Dedup[Dedup on normalizedPhone|rootDomain via tldts]
    Dedup --> ParseBasic[Name / Address / Phone / Website]
    ParseBasic --> HasWebsite{Website URL?}
    HasWebsite -->|yes| StaticDetect{Static page?}
    StaticDetect -->|yes| CheerioFetch[Cheerio fetch homepage]
    StaticDetect -->|no| Playwright[Playwright fetch homepage]
    CheerioFetch --> ExtractEmail[mailto links + regex + hardened filter]
    Playwright --> ExtractEmail
    CheerioFetch --> RefinePhone[libphonenumber-js + ISO hint]
    Playwright --> RefinePhone
    HasWebsite -->|depth=indepth| ContactPage[Follow /contact /about /team\nmax 4 pages 1 hop]
    ContactPage --> ExtractEmail
    ContactPage --> RefinePhone
    HasWebsite -->|no| UseDiscovery[Use discovery phone only]
    ExtractEmail --> Filter
    RefinePhone --> Filter
    UseDiscovery --> Filter
    Filter{email OR phone?\nRuns AFTER all scraping} -->|No| Discard[Discard + log + SSE\n+ failure metrics]
    Filter -->|Yes| QualityTier[Assign Tier1/2/3]
    QualityTier --> MemArray[Push to leads array + SSE lead event]
    MemArray -->|Export click| Sort[Sort: both-contact first]
    Sort --> Excel[Download .xlsx\nstreaming if >500]
```

### Step-by-Step

**Step 1 — Geocode Validation (with retry fallback)**
Before any scraping begins, the location string is sent to the Geocoding API. This resolves it to a canonical place (catching typos and ambiguous strings) and extracts the ISO 3166-1 alpha-2 country code (e.g. `IN`, `US`, `FR`). The country code is stored in the job context and passed to `libphonenumber-js` throughout the run as `defaultRegion`. **If the initial geocode fails, the system retries with a cleaned/normalized query** (trimming extra whitespace, removing special characters, normalizing encoding). Only after the retry also fails is a validation error returned to the UI.

**Step 2 — Discovery**
Outscraper API is called with `keyword + location`, requesting up to 100 results. The response contains: business name, formatted address, phone (raw), website URL, and place ID. If the Outscraper call fails (quota exhausted, API error), the system automatically switches to Playwright navigating `https://www.google.com/maps/search/<keyword>+<location>`, scrolling the result pane, and extracting equivalent fields.

**Step 3 — Deduplication (root domain via `tldts`)**
For each raw result: normalize the phone to E.164, extract the **root domain** from the website URL using the `tldts` library (correctly handles subdomains and multi-part TLDs like `.co.uk`, `.com.au`). Build a dedup key: `${normalizedPhone}|${rootDomain}`. If the key already exists in the job's `Set`, skip the entry and increment `duplicate_skipped` counter. If phone and domain are both empty, the entry passes through (cannot dedup without a key).

**Step 4 — Basic Parse**
Extract Business Name, Address, Phone, and Website URL from the discovery response. Ensure the website URL has `https://` prefix. Strip trailing slashes. Trim whitespace.

**Step 5 — Website Scraping (Dynamic Strategy)**
Before using Playwright, the scraper performs a static-page detection check:
1. Send a quick `fetch()` GET request with a 2-second timeout.
2. Inspect the HTML response for JS framework markers: `react`, `vue`, `angular`, `next`, `__NEXT_DATA__`, `ng-version`, `nuxt`.
3. If **no markers found** and the response arrived in **<2 seconds**: use **Cheerio** to parse the HTML (faster, lighter).
4. If **markers are detected** or the page is slow/complex: use **Playwright** with `waitUntil: 'networkidle'` to ensure JS-rendered content is loaded.

Non-200 responses, redirects to login pages, or timeouts: skip website step, mark `website_unreachable = true` and increment the `website_unreachable` failure counter. The lead may still qualify if phone was found in discovery.

Depth toggle behaviour:
- **Homepage only:** Extract from the homepage HTML exclusively.
- **In-depth:** After the homepage, scan `<a>` tags for internal links matching patterns `/contact`, `/contact-us`, `/about`, `/about-us`, `/team`, `/staff`, `/leadership`. Follow up to 4 matched links. No recursive crawl — 1 hop from homepage only.

**Step 6 — Email Extraction (Hardened)**
On each page visited (Playwright or Cheerio):
1. Query `document.querySelectorAll('a[href^="mailto:"]')` — cleanest source.
2. Regex on visible text: `/[\w.+\-]+@[\w\-]+\.[\w.]{2,}/g`.
3. **Remove duplicates** from combined list.
4. **Extended blacklist filter** — exclude emails containing any of: `noreply`, `no-reply`, `donotreply`, `example.com`, `sentry`, `cloudflare`, `amazonaws`, `google`, `facebook`, `wixpress.com`.
5. **Exclude non-company domains** (e.g. `gmail.com`, `yahoo.com`, `outlook.com`, `hotmail.com`) **unless** no company-domain email exists.
6. **Remove script/analytics noise** — exclude emails matching patterns like `webpack@`, `sourcemap@`, `tracking@`, or emails with suspiciously long local parts (>50 chars).
7. **Prefer emails whose domain matches the company's website root domain.**
8. Store the single best match. Priority: company-domain match > generic company email > freemail fallback. If no email remains after filtering, increment `email_not_found` counter.

**Step 7 — Phone Extraction**
1. Regex for common formats: `+<country> <number>`, `(<area>) <number>`, bare digit strings 8–15 digits.
2. Parse each match with `libphonenumber-js`, passing `defaultRegion` from Step 1.
3. Normalize to E.164 format.
4. If Outscraper already provided a phone, use it as primary. Website phone used only if discovery phone is missing.

**Step 8 — Filter (Post-Scrape Only)**
Check `lead.email || lead.phone`. **This filter runs ONLY after all scraping steps are complete** (discovery + website scraping + phone normalization + email extraction). No leads are discarded during the discovery stage — a lead without a phone from Outscraper may still gain one from its website. If both are falsy after all scraping steps: increment `discard_no_contact` counter, emit SSE `discard` event, log the business name and reason. Do not push to `leads[]`.

**Step 9 — Quality Tier + Push + SSE**
Assign an internal quality tier before pushing:
- **Tier 1:** email AND phone both present
- **Tier 2:** email only
- **Tier 3:** phone only

Qualifying lead is pushed to `leads[]` with the `_hasBoth` flag (`true` if Tier 1) and `_qualityTier` field. SSE `lead` event is emitted immediately — the frontend appends the row to the live table. The `_qualityTier` field is internal only and not exported.

**Step 10 — Export (on demand)**
On user click: sort `leads[]` descending by `_hasBoth` (both-contact leads first), generate `.xlsx` via `exceljs`, stream to browser as a file download. If `leads.length > 500`, the exporter internally uses a streaming writer to avoid memory spikes (no UI change). The in-memory array is not modified by the export.

---

## 4. Lead Discovery

### 4.1 Primary: Outscraper Google Maps API

Sign up at [outscraper.com](https://outscraper.com) for a free account (500 business extractions/month).

**API call:**
```
GET https://api.app.outscraper.com/maps/search
  ?query=<keyword>+<location>
  &limit=100
  &async=false
Headers:
  X-API-KEY: <your_outscraper_api_key>
```

**Response fields used:** `name`, `full_address`, `phone`, `site`, `place_id`.

Outscraper handles anti-bot internally. No rate limiting is needed on the client side for a single sequential call. The free tier covers approximately 5 full runs of 100 leads per month. At $3 per 1,000 records after the free tier, running 500 additional leads costs ~$1.50 — well within the $5–6/month budget.

If the Outscraper call returns a non-200 response or a quota-exceeded error, the system logs the error and automatically falls through to the fallback.

### 4.2 Fallback: Playwright on Google Maps

Used only when Outscraper is unavailable or quota is exhausted.

```typescript
const crawler = new PlaywrightCrawler({
  headless: true,
  requestHandlerTimeoutSecs: 60,
  async requestHandler({ page }) {
    await page.goto(
      `https://www.google.com/maps/search/${encodeURIComponent(keyword + ' ' + location)}`
    );
    await page.waitForSelector('[role="feed"]', { timeout: 15000 });

    // Scroll to load up to 100 results
    let prevCount = 0;
    while (true) {
      await page.evaluate(() =>
        document.querySelector('[role="feed"]')?.scrollBy(0, 1000)
      );
      await page.waitForTimeout(1500 + Math.random() * 500);
      const count = await page.$$eval('[role="feed"] > div', (els) => els.length);
      if (count >= 100 || count === prevCount) break;
      prevCount = count;
    }

    // Extract each business card
    const results = await page.$$eval('[role="feed"] > div', (cards) =>
      cards.map((card) => ({
        name: card.querySelector('[class*="fontHeadlineSmall"]')?.textContent?.trim() ?? '',
        address: card.querySelector('[class*="W4Efsd"] span:last-child')?.textContent?.trim() ?? '',
        // Phone and website require clicking into detail panel
      }))
    );
    // ... click into each result for phone/website
  },
});
```

Throttle: 2–4 seconds between each business detail panel click, with ±500ms random jitter. Use stealth plugin. Expect CAPTCHA after extended sessions on the same IP.

### 4.3 Alternate Directory Sources (Future)

For redundancy or region-specific coverage, the following can be added as additional discovery sources in later phases:
- **Yelp** (US-focused, has a developer API)
- **YellowPages** (US/AU)
- **Justdial** (India)
- **IndiaMart** (India, B2B)
- **Bing Maps API** (global, free tier available)

LinkedIn is explicitly excluded from all phases. They detect automation aggressively and have litigated against scrapers.

### 4.4 Data Returned from Discovery

At minimum, each raw entry must have:

| Field | Source | Notes |
|-------|--------|-------|
| Business Name | Outscraper / scraped | String, always present |
| Address | Outscraper / scraped | Full formatted string |
| Phone | Outscraper / scraped | Raw format — normalised in Step 7 |
| Website URL | Outscraper / scraped | May be absent |
| Place ID | Outscraper | For debug/logging only |

Entries missing phone and website are kept — the website scraping step may recover phone from the business's own site.

---

## 5. Website Extraction & Enrichment

### 5.1 Scraping Strategy (Dynamic Detection)

For every business with a valid website URL, the scraper **dynamically chooses** between Cheerio and Playwright:

```typescript
// scraper/detect.ts
const JS_FRAMEWORK_MARKERS = [
  '__NEXT_DATA__', 'react', 'vue', 'angular', 'ng-version',
  'nuxt', '__NUXT__', 'svelte', 'gatsby',
];

async function detectPageType(url: string): Promise<'static' | 'dynamic'> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return 'dynamic'; // let Playwright handle errors
    const html = await res.text();
    const lower = html.toLowerCase();

    const hasDynamicMarker = JS_FRAMEWORK_MARKERS.some((m) => lower.includes(m.toLowerCase()));
    return hasDynamicMarker ? 'dynamic' : 'static';
  } catch {
    return 'dynamic'; // timeout or fetch error → fall back to Playwright
  }
}
```

**Strategy:**
1. **Static pages (Cheerio):** If `detectPageType()` returns `'static'`, parse the already-fetched HTML with Cheerio. Significantly faster, no browser overhead.
2. **Dynamic pages (Playwright):** If markers are detected or detection fails, launch Playwright with `waitUntil: 'networkidle'`.
3. **Skip conditions**: HTTP 4xx/5xx, redirect to a login or auth page, timeout after 15s. Mark `website_unreachable = true`, increment `website_unreachable` failure counter. The lead may still qualify from discovery-phase phone data.

### 5.2 Email Extraction Rules

Applied on every page visited (homepage + sub-pages in in-depth mode):

```typescript
import { parse as parseTld } from 'tldts';

// Extended blacklist — catches junk, analytics, and infrastructure emails
const EMAIL_BLACKLIST = [
  'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'example.com', 'sentry', 'cloudflare', 'amazonaws',
  'google', 'facebook', 'wixpress.com',
];

// Non-company freemail domains — used only as fallback
const FREEMAIL_DOMAINS = [
  'gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com',
  'aol.com', 'icloud.com', 'mail.com', 'protonmail.com',
  'yandex.com', 'zoho.com',
];

// Script/analytics noise patterns
const NOISE_PATTERNS = [
  /^webpack@/i, /^sourcemap@/i, /^tracking@/i,
  /^pixel@/i, /^analytics@/i, /^error@/i,
];

/**
 * Extracts the best email from a page.
 * Works with both Playwright Page and raw HTML string (Cheerio path).
 */
async function extractEmails(
  pageOrHtml: Page | string,
  companyDomain: string
): Promise<string> {
  let mailtoEmails: string[] = [];
  let bodyText: string = '';

  if (typeof pageOrHtml === 'string') {
    // Cheerio path — pageOrHtml is raw HTML
    const $ = cheerio.load(pageOrHtml);
    mailtoEmails = $('a[href^="mailto:"]')
      .map((_, el) => $(el).attr('href')!.replace('mailto:', '').split('?')[0].trim())
      .get();
    bodyText = $.text();
  } else {
    // Playwright path
    mailtoEmails = await pageOrHtml.$$eval(
      'a[href^="mailto:"]',
      (els) => els.map((el) => el.getAttribute('href')!.replace('mailto:', '').split('?')[0].trim())
    );
    bodyText = await pageOrHtml.evaluate(() => document.body.innerText);
  }

  // Step 2: regex on visible text
  const regexEmails = [...bodyText.matchAll(/[\w.+\-]+@[\w\-]+\.[\w.]{2,}/g)].map((m) => m[0]);

  // Step 3: deduplicate
  const allEmails = [...new Set([...mailtoEmails, ...regexEmails].map((e) => e.toLowerCase().trim()))];

  // Step 4: extended blacklist filter
  const afterBlacklist = allEmails.filter(
    (e) =>
      e.includes('@') &&
      e.includes('.') &&
      !EMAIL_BLACKLIST.some((b) => e.includes(b))
  );

  // Step 5: remove script/analytics noise + suspiciously long local parts
  const afterNoise = afterBlacklist.filter((e) => {
    const localPart = e.split('@')[0];
    if (localPart.length > 50) return false;
    if (NOISE_PATTERNS.some((p) => p.test(e))) return false;
    return true;
  });

  // Step 6: separate company-domain vs freemail vs other
  const companyRoot = parseTld(companyDomain)?.domain ?? companyDomain;
  const companyEmails = afterNoise.filter((e) => {
    const emailDomain = parseTld(e.split('@')[1])?.domain;
    return emailDomain === companyRoot;
  });
  const nonFreemail = afterNoise.filter(
    (e) => !FREEMAIL_DOMAINS.includes(e.split('@')[1])
  );
  const freemail = afterNoise.filter(
    (e) => FREEMAIL_DOMAINS.includes(e.split('@')[1])
  );

  // Step 7: priority — company domain match > non-freemail > freemail fallback
  return companyEmails[0] ?? nonFreemail[0] ?? freemail[0] ?? '';
}
```

### 5.3 Phone Extraction Rules

```typescript
import { parsePhoneNumberFromString } from 'libphonenumber-js';

function extractPhone(pageText: string, existingPhone: string, isoCountry: string): string {
  // If discovery already gave a valid phone, normalize and return it
  if (existingPhone) {
    const parsed = parsePhoneNumberFromString(existingPhone, isoCountry as any);
    if (parsed?.isValid()) return parsed.format('E.164');
  }

  // Regex for phone patterns on page
  const patterns = [
    /\+[\d\s\-().]{7,20}/g,
    /\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}/g,
    /\d{8,15}/g,
  ];

  for (const pattern of patterns) {
    const matches = [...pageText.matchAll(pattern)];
    for (const match of matches) {
      const parsed = parsePhoneNumberFromString(match[0], isoCountry as any);
      if (parsed?.isValid()) return parsed.format('E.164');
    }
  }

  return '';
}
```

### 5.4 In-Depth Mode: Sub-Page Discovery

```typescript
async function getContactSubPages(page: Page, baseUrl: string): Promise<string[]> {
  const patterns = ['/contact', '/contact-us', '/about', '/about-us', '/team', '/staff', '/leadership'];
  const links = await page.$$eval('a[href]', (els) =>
    els.map((el) => (el as HTMLAnchorElement).href)
  );

  const baseDomain = new URL(baseUrl).hostname;
  const matched: string[] = [];

  for (const link of links) {
    try {
      const url = new URL(link);
      if (url.hostname !== baseDomain) continue; // internal links only
      if (patterns.some((p) => url.pathname.startsWith(p))) {
        matched.push(url.href);
      }
    } catch {
      continue;
    }
  }

  return [...new Set(matched)].slice(0, 4); // max 4 sub-pages
}
```

---

## 6. Data Model & Output

### 6.1 Lead Object

```typescript
type QualityTier = 'Tier1' | 'Tier2' | 'Tier3';

interface Lead {
  businessName: string;    // Always present
  email: string;           // Empty string if not found — never null
  phone: string;           // E.164 format, empty string if not found
  website: string;         // Full URL with https://, empty string if not found
  address: string;         // Always present
  _hasBoth: boolean;       // true if email AND phone both present — export sort key, not exported
  _qualityTier: QualityTier; // Internal only — Tier1: email+phone, Tier2: email only, Tier3: phone only
}
```

> **Note:** `_qualityTier` is internal only. It is NOT included in the Excel export and does NOT appear in SSE payloads to the frontend. The `_hasBoth` flag is preserved for backward-compatible sorting.

### 6.2 In-Memory Store Module

```typescript
// store.ts
let leads: Lead[] = [];
let discardCount = 0;
export type JobStatus = 'idle' | 'running' | 'stopped' | 'completed' | 'error';
let jobStatus: JobStatus = 'idle';

// Failure metrics counters (Enhancement #9)
interface FailureMetrics {
  discard_no_contact: number;
  website_unreachable: number;
  email_not_found: number;
  phone_not_found: number;
  duplicate_skipped: number;
  captcha_blocked: number;
}

let failureMetrics: FailureMetrics = {
  discard_no_contact: 0,
  website_unreachable: 0,
  email_not_found: 0,
  phone_not_found: 0,
  duplicate_skipped: 0,
  captcha_blocked: 0,
};

export const store = {
  reset() {
    leads = [];
    discardCount = 0;
    jobStatus = 'idle';
    failureMetrics = {
      discard_no_contact: 0,
      website_unreachable: 0,
      email_not_found: 0,
      phone_not_found: 0,
      duplicate_skipped: 0,
      captcha_blocked: 0,
    };
  },
  addLead(lead: Lead) {
    leads.push(lead);
  },
  discard() {
    discardCount++;
  },
  incrementMetric(metric: keyof FailureMetrics) {
    failureMetrics[metric]++;
  },
  getLeads(): Lead[] {
    return leads;
  },
  getStats() {
    return { leadCount: leads.length, discardCount, jobStatus };
  },
  getFailureMetrics(): FailureMetrics {
    return { ...failureMetrics };
  },
  setStatus(s: JobStatus) {
    jobStatus = s;
  },
};
```

Data lives only while the Node.js process runs. Starting a new job calls `store.reset()` — previous session's leads are lost. Export before starting a new job or restarting the server.

### 6.3 Deduplication

```typescript
import { parse as parseTld } from 'tldts';

const dedupSet = new Set<string>();

function isDuplicate(phone: string, website: string): boolean {
  // Extract root domain using tldts — handles subdomains + multi-part TLDs (.co.uk, .com.au)
  const rootDomain = website ? (parseTld(website)?.domain ?? '') : '';
  const key = `${phone}|${rootDomain}`;

  if (!phone && !rootDomain) return false; // cannot dedup without a key
  if (dedupSet.has(key)) {
    store.incrementMetric('duplicate_skipped');
    return true;
  }

  dedupSet.add(key);
  return false;
}
```

### 6.4 Filter & Push

```typescript
function processLead(raw: RawLead, email: string, phone: string, website: string) {
  // Filter runs ONLY after all scraping steps are complete
  if (!email && !phone) {
    store.discard();
    store.incrementMetric('discard_no_contact');
    sseEmit({ event: 'discard', data: store.getStats() });
    logger.info(`Discarded: ${raw.name} — no email or phone found`);
    return;
  }

  // Track individual missing fields
  if (!email) store.incrementMetric('email_not_found');
  if (!phone) store.incrementMetric('phone_not_found');

  // Assign quality tier (internal only)
  const _qualityTier: QualityTier =
    email && phone ? 'Tier1' :
    email           ? 'Tier2' :
                      'Tier3';

  const lead: Lead = {
    businessName: raw.name,
    email,
    phone,
    website,
    address: raw.address,
    _hasBoth: !!(email && phone),
    _qualityTier,
  };

  store.addLead(lead);
  sseEmit({ event: 'lead', data: lead });
}
```

### 6.5 Excel Export

```typescript
// export.ts
import ExcelJS from 'exceljs';
import { Lead } from './types';
import { Writable } from 'stream';

// Threshold for switching to streaming writer (scalability prep)
const STREAMING_THRESHOLD = 500;

export async function generateExcel(leads: Lead[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Lead Scraper';
  wb.created = new Date();

  const ws = wb.addWorksheet('Leads');

  ws.columns = [
    { header: 'Business Name', key: 'businessName', width: 32 },
    { header: 'Email',         key: 'email',         width: 30 },
    { header: 'Phone',         key: 'phone',         width: 20 },
    { header: 'Website',       key: 'website',       width: 32 },
    { header: 'Address',       key: 'address',       width: 38 },
  ];

  // Header row styling
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E1E2E' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'left' };
  headerRow.height = 22;

  // Freeze header
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  // Sort: leads with both email + phone first
  const sorted = [...leads].sort((a, b) => Number(b._hasBoth) - Number(a._hasBoth));

  sorted.forEach((lead) => {
    const row = ws.addRow({
      businessName: lead.businessName,
      email:        lead.email   || '',
      phone:        lead.phone   || '',
      website:      lead.website || '',
      address:      lead.address,
    });

    // Green highlight for Tier 1 (both email + phone)
    if (lead._hasBoth) {
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } };
    }

    // Make website a hyperlink if present
    if (lead.website) {
      row.getCell('website').value = {
        text: lead.website,
        hyperlink: lead.website,
      };
      row.getCell('website').font = { color: { argb: 'FF1565C0' }, underline: true };
    }

    row.alignment = { vertical: 'middle', wrapText: false };
  });

  // Auto-filter on header row
  ws.autoFilter = { from: 'A1', to: 'E1' };

  return wb.xlsx.writeBuffer() as Promise<Buffer>;
}

/**
 * Streaming writer for large lead sets (>500).
 * Same output format, but writes rows incrementally to avoid memory spikes.
 * Structured for future use — activated when leads.length > STREAMING_THRESHOLD.
 * No UI change required.
 */
export async function generateExcelStreaming(
  leads: Lead[],
  outputStream: Writable
): Promise<void> {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: outputStream });
  const ws = wb.addWorksheet('Leads');

  ws.columns = [
    { header: 'Business Name', key: 'businessName', width: 32 },
    { header: 'Email',         key: 'email',         width: 30 },
    { header: 'Phone',         key: 'phone',         width: 20 },
    { header: 'Website',       key: 'website',       width: 32 },
    { header: 'Address',       key: 'address',       width: 38 },
  ];

  const sorted = [...leads].sort((a, b) => Number(b._hasBoth) - Number(a._hasBoth));

  for (const lead of sorted) {
    const row = ws.addRow({
      businessName: lead.businessName,
      email:        lead.email   || '',
      phone:        lead.phone   || '',
      website:      lead.website || '',
      address:      lead.address,
    });
    if (lead._hasBoth) {
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } };
    }
    row.commit();
  }

  await wb.commit();
}

/**
 * Route handler chooses writer based on lead count.
 * No change to API contract or frontend behaviour.
 */
export function shouldUseStreaming(leadCount: number): boolean {
  return leadCount > STREAMING_THRESHOLD;
}
```

### 6.6 API Contracts

| Endpoint | Method | Body / Params | Response |
|----------|--------|---------------|----------|
| `/api/start` | POST | `{ keyword, location, depth }` | `{ jobId }` or `{ error: 'invalid_location' }` |
| `/api/stop` | POST | `{ jobId }` | `{ leadCount, discardCount }` |
| `/api/status` | GET | — | `{ status, leadCount, discardCount }` |
| `/api/stream` | GET | `?jobId=<id>` | SSE stream (text/event-stream) |
| `/api/export` | GET | `?jobId=<id>` | `.xlsx` file download stream |

**SSE event types emitted by `/api/stream`:**

| Event | Payload | When |
|-------|---------|------|
| `lead` | `Lead` object | Each qualifying lead found |
| `discard` | `{ total: number }` | Each discarded lead |
| `status` | `{ status, leadCount, discardCount }` | Job state changes |
| `error` | `{ message: string }` | Non-fatal errors (CAPTCHA, block, timeout) |

---

## 7. Front-End Dashboard

### 7.1 UI Structure

```
+-------------------------------------------------------------------------+
| LEAD SCRAPER                                                             |
+-------------------------------------------------------------------------+
| Keyword  [_____________________________]                                 |
| Location [_____________________________]  ← validated before job starts  |
| Depth    (●) Homepage   ( ) In-depth                                    |
|                                          [▶ Start]   [■ Stop]           |
+-------------------------------------------------------------------------+
| Status: Running — 34 leads found, 6 discarded (no contact info)  [···]  |
+-------------------------------------------------------------------------+
| Business Name        | Email               | Phone        | Website      | Address           |
|----------------------|---------------------|--------------|--------------|-------------------|
| Acme Marketing Ltd   | info@acme.in        | +91-981...   | acme.in      | New Delhi, India  |
| Smile Dental Care    | smile@dental.co.uk  | +44-161...   |              | Manchester, UK    |
| Floral Fantasies     |                     | +44-207...   | floralfn.uk  | London, UK        |
+-------------------------------------------------------------------------+
  6 leads discarded (no email or phone found)
                                                    [↓ Export to Excel]
```

### 7.2 Behaviour

**Start flow:**
1. User fills in keyword and location, selects depth, clicks Start.
2. Frontend calls `POST /api/start`. Backend validates location via Geocoding API.
3. If invalid: show inline error under location field. Do not start.
4. If valid: receive `{ jobId }`, open `EventSource('/api/stream?jobId=...')`, disable Start button, enable Stop.

**Live table:**
- Each SSE `lead` event appends a row immediately.
- SSE `discard` events increment the discard counter displayed below the table.
- SSE `status` events update the status bar text.
- No polling. No manual refresh.

**Stop flow:**
1. User clicks Stop.
2. `POST /api/stop`. Backend drains queue, closes browsers (10s max), sets status `stopped`.
3. SSE emits final `status` event with `stopped`. EventSource closes.
4. Table retains all collected rows. Export button remains enabled.

**Export:**
Single button "Export to Excel". Enabled once `leads.length >= 1`. On click: `window.location.href = '/api/export?jobId=...'`. Browser downloads the file. The in-memory array is not affected.

### 7.3 SSE Client Code

```typescript
// components/ScraperDashboard.tsx
const [leads, setLeads] = useState<Lead[]>([]);
const [discardCount, setDiscardCount] = useState(0);
const [jobStatus, setJobStatus] = useState<string>('idle');
const [statusMsg, setStatusMsg] = useState('');

function startJob(keyword: string, location: string, depth: string) {
  fetch('/api/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyword, location, depth }),
  })
    .then((r) => r.json())
    .then(({ jobId, error }) => {
      if (error) { setStatusMsg(error); return; }

      const es = new EventSource(`/api/stream?jobId=${jobId}`);

      es.addEventListener('lead', (e) => {
        setLeads((prev) => [...prev, JSON.parse(e.data)]);
      });

      es.addEventListener('discard', (e) => {
        setDiscardCount(JSON.parse(e.data).total);
      });

      es.addEventListener('status', (e) => {
        const payload = JSON.parse(e.data);
        setJobStatus(payload.status);
        setStatusMsg(
          `${payload.status === 'running' ? 'Running' : 'Done'} — ` +
          `${payload.leadCount} leads, ${payload.discardCount} discarded`
        );
        if (['completed', 'stopped', 'error'].includes(payload.status)) es.close();
      });

      es.addEventListener('error', (e) => {
        setStatusMsg(`Warning: ${JSON.parse(e.data).message}`);
      });
    });
}
```

---

## 8. Tools & Technology Stack

### 8.1 Definitive Stack

```
Runtime:      Node.js 20 LTS
Language:     TypeScript 5
Frontend:     Next.js 14 (App Router) + React 18 + Tailwind CSS 3
Backend:      Express 4 (separate Node.js server, not Next.js API routes)
Crawler:      Crawlee 3 (PlaywrightCrawler)
Headless:     Playwright (Chromium)
Static parse: Cheerio
Domain parse: tldts (root domain extraction for dedup + email matching)
Discovery:    Outscraper API (primary) → Playwright/Maps (fallback)
Phone:        libphonenumber-js
Export:       exceljs
Live updates: Server-Sent Events (built-in, no library)
Logging:      winston
Process mgr:  pm2 (VPS deployment only)
```

### 8.2 Tool Comparison

| Component | Choice | Pros | Cons | Cost |
|-----------|--------|------|------|------|
| **Crawler** | Crawlee ✅ | Queue, retries, concurrency, fingerprinting, Playwright-native | Abstraction overhead | Free OSS |
| | Raw Playwright | Full control | Must build queue, retry, session logic manually | Free OSS |
| **Headless** | Playwright ✅ | Multi-browser, stealth plugins, Crawlee-native, modern API | Chromium binary size | Free OSS |
| | Puppeteer | Google-supported, Chrome-native | Chrome only, lighter Crawlee integration | Free OSS |
| | Selenium | Multi-language, mature | Slow, more detectable, outdated API | Free OSS |
| **Discovery** | Outscraper ✅ primary | No anti-bot risk, structured JSON, simple REST call | 500/mo free; $3/1k after | Free (500/mo) |
| | Google Places API | Official, reliable | Billing account required, per-call cost | $200/mo credit |
| | Playwright/Maps | No vendor | CAPTCHA-prone, fragile to DOM changes | Free (code only) |
| **Phone** | libphonenumber-js ✅ | Google's library, global coverage, E.164 output, country hint support | Requires country code input | Free OSS |
| **Export** | exceljs ✅ | Real .xlsx, formatting, hyperlinks, autofilter, streaming buffer | — | Free OSS |
| **Live updates** | SSE ✅ | Native browser API, works in Next.js, no extra infrastructure | Unidirectional (fine for this use case) | Free built-in |
| **Proxy** | None first | Zero cost | — | Free |
| | Free public proxies | No cost | Unreliable, frequently banned | Free |
| | Paid datacenter | Reliable | >$5/mo minimum | ~$5/mo |

---

## 9. Anti-Blocking & Reliability

### 9.1 Per-Source Rate Limits

| Source | Delay Between Requests | Max Concurrent | Skip After |
|--------|------------------------|----------------|------------|
| Outscraper API | None (server-managed) | 1 sequential | 3 consecutive API errors |
| Google Maps (Playwright) | 2–4s per action ±500ms jitter | 2 browser pages | CAPTCHA detected |
| Business website (detail) | 1–2s between sites | 1–5 adaptive (see §13.3) | 2 consecutive timeouts per domain |
| Directory fallbacks (Yelp, etc.) | 2–3s per page | 1 per directory | 3 consecutive 429 responses |

### 9.2 Techniques

**User-Agent Rotation**
Crawlee's `SessionPool` manages UA rotation automatically. Each session gets a randomised UA from a pool of real browser strings. Configure pool size to 10+ sessions.

**Stealth**
Use `puppeteer-extra-plugin-stealth` (compatible with Playwright via wrapper) for the Google Maps fallback scraper. Masks `navigator.webdriver`, missing browser plugins, and other headless signals. Not needed for Outscraper (server-side).

**Retries**
Crawlee retries failed requests up to 2 times with exponential backoff: 2s then 4s. After 2 retries, the request is marked failed, the lead is logged as unresolved, and the crawler moves on.

**CAPTCHA Detection**
```typescript
// Detect Google CAPTCHA
if (page.url().includes('/sorry/') || await page.$('form#captcha-form')) {
  store.incrementMetric('captcha_blocked');
  sseEmit({ event: 'error', data: { message: 'CAPTCHA detected on Google Maps. Consider switching to Outscraper or pausing.' } });
  throw new Error('CAPTCHA'); // triggers Crawlee retry
}
```
Do not attempt auto-solve on this budget. Surface it to the user via SSE and let them decide to stop or wait.

**SSE Connection Safety**
SSE connections are tracked per `jobId` in a server-side `Map`. This prevents memory leaks from orphaned connections:

```typescript
// sse.ts — connection tracking
const activeConnections = new Map<string, Response>();

export function registerSSEConnection(jobId: string, res: Response) {
  // Close any existing connection for this jobId
  const existing = activeConnections.get(jobId);
  if (existing && !existing.writableEnded) {
    existing.end();
    logger.info(`Closed previous SSE connection for job ${jobId}`);
  }

  activeConnections.set(jobId, res);

  // Clean up on client disconnect
  res.on('close', () => {
    activeConnections.delete(jobId);
    logger.info(`SSE connection closed for job ${jobId}`);
  });
}

export function closeSSEConnection(jobId: string) {
  const conn = activeConnections.get(jobId);
  if (conn && !conn.writableEnded) {
    conn.end();
  }
  activeConnections.delete(jobId);
}
```

Connections are automatically closed on:
- **New connection** for the same `jobId` (previous one is terminated)
- **Job stop** (`POST /api/stop` calls `closeSSEConnection(jobId)`)
- **Job completion** (pipeline end calls `closeSSEConnection(jobId)`)
- **Client disconnect** (`res.on('close')` handler)

**Stop Handler — Hard Timeout**
The stop handler enforces a maximum drain timeout of 10 seconds. After timeout, all Playwright browser contexts are force-closed:

```typescript
// routes/stop.ts
async function handleStop(jobId: string) {
  store.setStatus('stopped');

  // Signal Crawlee to stop accepting new requests
  crawler.autoscaledPool?.abort();

  // Wait for in-flight pages with hard timeout
  const drainPromise = crawler.autoscaledPool?.isFinished() ?? Promise.resolve();
  const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, 10_000));

  await Promise.race([drainPromise, timeoutPromise]);

  // Force-close ALL browser contexts regardless of in-flight state
  try {
    const contexts = browserPool?.getActiveBrowserContexts() ?? [];
    await Promise.all(contexts.map((ctx) => ctx.close().catch(() => {})));
    logger.info(`Force-closed ${contexts.length} browser context(s) after stop`);
  } catch (err) {
    logger.warn(`Error closing browser contexts: ${err}`);
  }

  // Close SSE connection for this job
  closeSSEConnection(jobId);

  sseEmit({ event: 'status', data: store.getStats() });
  return store.getStats();
}
```

**Geocoding Fallback**
If the initial geocode request fails, the system retries with a cleaned/normalized query before returning an error:

```typescript
// geocode.ts
function cleanLocationQuery(query: string): string {
  return query
    .replace(/[^\w\s,.-]/g, '')    // remove special characters
    .replace(/\s+/g, ' ')          // collapse whitespace
    .trim();
}

async function geocodeLocation(location: string): Promise<GeocodeResult | null> {
  // First attempt: original query
  let result = await callGeocodingAPI(location);
  if (result) return result;

  // Retry with cleaned query
  const cleaned = cleanLocationQuery(location);
  if (cleaned !== location) {
    logger.info(`Geocode retry with cleaned query: "${cleaned}"`);
    result = await callGeocodingAPI(cleaned);
    if (result) return result;
  }

  // Both attempts failed
  logger.warn(`Geocode failed for: "${location}" (cleaned: "${cleaned}")`);
  return null;
}
```

**Headful Fallback**
If a specific site consistently detects headless mode, run that domain in headful mode (`headless: false`). Only practical for the Maps fallback, not for high-volume website scraping.

**Proxy Strategy**
1. Run without proxy first (developer machine residential IP).
2. If 3+ blocks occur in a session: insert a free proxy from ProxyScrape (use cautiously — unreliable, may itself be blocked).
3. If blocks persist: upgrade to a $5/mo datacenter proxy for the scraping session.

---

## 10. Compliance & Ethical Considerations

**Public Data Only**
Only scrape information that is publicly accessible without authentication. Business contact info on company websites and Google Maps listings is public data. Never bypass logins or scrape behind authentication walls.

**robots.txt**
Configure via environment variable:
```
RESPECT_ROBOTS_TXT=true
```
When `true`, use `robots-parser` to check each domain before scraping. Skip paths disallowed by robots.txt. Implement in ~2 hours. Ethically sound and legally relevant in some jurisdictions. Defaults to `true`.

```typescript
import robotsParser from 'robots-parser';

const robotsCache = new Map<string, ReturnType<typeof robotsParser>>();

async function isAllowed(url: string): Promise<boolean> {
  if (process.env.RESPECT_ROBOTS_TXT !== 'true') return true;

  const { origin } = new URL(url);
  if (!robotsCache.has(origin)) {
    const res = await fetch(`${origin}/robots.txt`).catch(() => null);
    const text = res?.ok ? await res.text() : '';
    robotsCache.set(origin, robotsParser(`${origin}/robots.txt`, text));
  }

  return robotsCache.get(origin)!.isAllowed(url, 'Googlebot') ?? true;
}
```

**Privacy Laws**

| Region | Law | Requirement for B2B outreach |
|--------|-----|------------------------------|
| EU / UK | GDPR | Only contact clearly company-level emails (`info@`, `contact@`). Document lawful basis. Provide opt-out immediately. |
| US | CAN-SPAM | B2B unsolicited email allowed under opt-out rules. Include unsubscribe mechanism. |
| India | IT Act | Broadly allows contacting business entities via public information. |

The scraper does not auto-enforce compliance. The outreach team is responsible for applying the correct rules per region.

**LinkedIn:** Explicitly excluded from all phases. Aggressive detection, documented litigation against scrapers.

**Rate & Load:** Maximum 3 concurrent requests per domain prevents any DDoS-like impact. Legal risk under CFAA (US) is low for public-page reading only.

---

## 11. Operational Runbook & Monitoring

**Logging (winston)**
```typescript
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) =>
      `${timestamp} [${level.toUpperCase()}] ${message}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: './logs/scraper.log' }),
  ],
});
```

Log: job start (keyword, location, depth), each lead found (name, email present, phone present), each discard (name, reason), errors (source, type), job end (total leads, total discards, duration).

**Alerts**
All non-fatal errors (CAPTCHA detected, domain timeout, website unreachable) are surfaced to the UI via SSE `error` events. Fatal errors (unhandled exceptions) crash the job — status becomes `error`.

**Local Deployment**
Console logs + `./logs/scraper.log`. Job status visible in UI status bar. No additional monitoring tooling needed.

**VPS Deployment**
```bash
pm2 start dist/server.js --name lead-scraper
pm2 logs lead-scraper
pm2 monit
```
`pm2` auto-restarts on crash. Monitor memory usage during scraping — 2–3 concurrent Playwright pages use 200–500MB.

**Data Loss Risk**
By design, data is not persisted. If the process crashes mid-run, in-progress leads are lost. Best practice: export immediately after job completes. Do not restart the server before exporting.

**Scheduling**
Manual job start only (MVP). Future: `node-cron` for scheduled daily runs.

---

## 12. Testing & Quality Assurance

**Unit Tests**
- Email regex: valid addresses, addresses with special chars, junk strings, `noreply@` filtering, **extended blacklist** (`sentry`, `cloudflare`, `amazonaws`, `google`, `facebook`), freemail fallback logic, script/analytics noise rejection.
- Phone normalization: US number with `defaultRegion: US`, Indian number with `defaultRegion: IN`, number with country code already present, unparseable string returns empty.
- **Root domain extraction** (`tldts`): `www.shop.co.uk` → `shop.co.uk`, `blog.example.com` → `example.com`.
- Dedup logic: same phone different domain → duplicate; same domain different phone → duplicate; no phone no domain → not duplicate. **Verify `duplicate_skipped` counter increments.**
- Filter logic: lead with email only → kept (Tier2); lead with phone only → kept (Tier3); lead with both → kept (Tier1); lead with neither → discarded, `discard_no_contact` incremented.
- **Quality tier assignment**: verify Tier1/Tier2/Tier3 is correctly assigned based on email/phone presence.
- Sort logic: mix of `_hasBoth: true/false` → true rows all appear before false rows in sorted output.
- **Failure metrics**: verify each counter (`discard_no_contact`, `website_unreachable`, `email_not_found`, `phone_not_found`, `duplicate_skipped`, `captcha_blocked`) increments correctly and resets on `store.reset()`.

**Integration Tests**
- Run "Flower Shop, London" → verify ≥50 leads returned, all have name + address, none have both email and phone empty, Excel file opens correctly in Excel and Google Sheets.
- Run "Digital Marketing Agency, Noida" → verify E.164 phone format on Indian numbers.
- Run an invalid location ("asdfasdf") → verify validation error returned before any scraping starts.

**Filter Test**
Inject a mock lead with `email: ''` and `phone: ''`. Verify it does not appear in `store.getLeads()` and `discardCount` increments by 1.

**Export Test**
Generate Excel with a mix of Tier 1 (both) and Tier 2 (one contact method) leads. Open file and verify: Tier 1 rows have green fill, Tier 1 rows all appear before Tier 2 rows, website cells are hyperlinks, blank cells contain empty string (not "null", "undefined", or "N/A"), autofilter is present on row 1.

**SSE Test**
Connect `EventSource`, start a job, verify `lead` events arrive and match `leads[]`, verify `discard` events fire for filtered leads, verify `status` event with `completed` or `stopped` fires at job end and closes stream. **Verify that opening a second SSE connection for the same jobId closes the first connection (no duplicate events).**

**Stop Test**
Start a job, stop after ~10 leads. Verify: job status becomes `stopped`, `leads[]` retains the 10 collected leads, export generates a valid Excel file with those 10 rows, no Chromium processes remain (check with `ps aux | grep chromium`). **Verify hard timeout: if in-flight pages hang, browser contexts are force-closed within 10 seconds.**

**Geocode Fallback Test**
Send a location with extra whitespace or special characters (e.g. `"  London , UK! "`). Verify the geocoder retries with a cleaned query and succeeds. Verify a truly invalid location ("asdfasdf") still returns an error after both attempts.

**Dynamic Detection Test**
Test `detectPageType()` against a known static site (e.g. a simple HTML page) and a known React/Next.js site. Verify static pages use Cheerio path and dynamic pages use Playwright path.

**Manual Spot-Check**
After each integration run, pick 5 leads at random, visit their actual websites, and confirm scraped email and phone are correct. This catches regex false-positives.

---

## 13. Setup & Execution Guide

### 13.1 System Requirements

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| Node.js | 18 LTS | 20 LTS |
| RAM | 4 GB | 8 GB |
| OS | Ubuntu 22.04 / macOS 13 / Windows 11 WSL2 | Ubuntu 22.04 LTS |
| Disk | 2 GB free | 5 GB free |
| Internet | Required | Stable broadband |

Playwright downloads Chromium (~200MB) on first install. Ensure disk space.

### 13.2 Project Structure

```
lead-scraper/
├── backend/
│   ├── src/
│   │   ├── server.ts          # Express app entry point
│   │   ├── routes/
│   │   │   ├── start.ts       # POST /api/start
│   │   │   ├── stop.ts        # POST /api/stop
│   │   │   ├── status.ts      # GET /api/status
│   │   │   ├── stream.ts      # GET /api/stream (SSE)
│   │   │   └── export.ts      # GET /api/export
│   │   ├── scraper/
│   │   │   ├── discovery.ts   # Outscraper API + Maps fallback
│   │   │   ├── detail.ts      # Playwright/Cheerio website scraper
│   │   │   ├── detect.ts      # Static vs dynamic page detection
│   │   │   ├── email.ts       # Email extraction (hardened)
│   │   │   ├── phone.ts       # Phone extraction + normalisation
│   │   │   ├── dedup.ts       # In-memory dedup Set (tldts)
│   │   │   └── filter.ts      # Discard logic + quality tier
│   │   ├── export.ts          # exceljs Excel generation
│   │   ├── store.ts           # In-memory leads array
│   │   ├── sse.ts             # SSE emitter helper
│   │   ├── geocode.ts         # Location validation + ISO code
│   │   ├── robots.ts          # robots.txt checker
│   │   └── logger.ts          # winston config
│   ├── package.json
│   ├── tsconfig.json
│   └── .env
├── frontend/
│   ├── app/
│   │   ├── page.tsx           # Dashboard
│   │   └── layout.tsx
│   ├── components/
│   │   ├── InputPanel.tsx
│   │   ├── StatusBar.tsx
│   │   ├── ResultsTable.tsx
│   │   └── ExportButton.tsx
│   ├── package.json
│   └── .env.local
├── logs/                      # Auto-created by winston
├── .gitignore
└── README.md
```

### 13.3 Environment Variables

**`backend/.env`**
```env
# Required
OUTSCRAPER_API_KEY=your_outscraper_api_key_here
GOOGLE_GEOCODING_API_KEY=your_google_geocoding_api_key_here

# Server
PORT=4000
NODE_ENV=development

# Scraping behaviour
RESPECT_ROBOTS_TXT=true
MAX_LEADS_PER_RUN=100
SCRAPE_DEPTH=homepage          # homepage | indepth (overridden by UI toggle)
CONCURRENCY_MIN=1              # Adaptive concurrency lower bound
CONCURRENCY_MAX=5              # Adaptive concurrency upper bound

# Anti-blocking
REQUEST_DELAY_MS=2000          # Base delay between website requests
REQUEST_DELAY_JITTER_MS=500    # Random jitter added to delay

# Optional proxy (leave empty to disable)
PROXY_URL=                     # e.g. http://user:pass@proxy.example.com:8080

# Logging
LOG_LEVEL=info                 # debug | info | warn | error
LOG_FILE=./logs/scraper.log
```

**`frontend/.env.local`**
```env
NEXT_PUBLIC_API_URL=http://localhost:4000
```

### 13.4 API Keys Setup

**Outscraper (required for primary discovery)**
1. Go to [outscraper.com](https://outscraper.com) → Sign Up (free account).
2. Dashboard → API Keys → Create Key.
3. Copy key into `backend/.env` as `OUTSCRAPER_API_KEY`.
4. Free tier: 500 business extractions/month. No credit card required.

**Google Geocoding API (required for location validation)**
1. Go to [console.cloud.google.com](https://console.cloud.google.com).
2. Create a project → Enable "Geocoding API".
3. APIs & Services → Credentials → Create API Key.
4. The free tier includes $200/month credit — far exceeds needs for location validation (fractions of a cent per call).
5. Copy key into `backend/.env` as `GOOGLE_GEOCODING_API_KEY`.

### 13.5 Installation

```bash
# Clone or create the project
git clone <your-repo> lead-scraper
cd lead-scraper

# Install backend dependencies
cd backend
npm install
npm install crawlee playwright-core cheerio exceljs libphonenumber-js \
  tldts winston robots-parser axios express cors dotenv
npm install -D typescript ts-node @types/node @types/express nodemon

# Install Playwright browsers (downloads Chromium ~200MB)
npx playwright install chromium

# Install frontend dependencies
cd ../frontend
npm install
# (Next.js, React, Tailwind are already in package.json)
```

**`backend/tsconfig.json`**
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**`backend/package.json` scripts**
```json
{
  "scripts": {
    "dev": "nodemon --exec ts-node src/server.ts",
    "build": "tsc",
    "start": "node dist/server.ts",
    "start:pm2": "pm2 start dist/server.js --name lead-scraper"
  }
}
```

### 13.6 Running Locally (Development)

Open two terminal windows:

**Terminal 1 — Backend:**
```bash
cd backend
cp .env.example .env          # fill in API keys
npm run dev
# Server starts on http://localhost:4000
# Output: [INFO] Lead Scraper backend running on port 4000
```

**Terminal 2 — Frontend:**
```bash
cd frontend
npm run dev
# Next.js starts on http://localhost:3000
```

Open `http://localhost:3000` in your browser.

**First run checklist:**
- [ ] Outscraper API key entered in `.env`
- [ ] Google Geocoding API key entered in `.env`
- [ ] Both servers running without errors
- [ ] Enter keyword "dental clinic" and location "London, UK", click Start
- [ ] Confirm rows appear in the live table
- [ ] Confirm discard counter updates for leads with no contact info
- [ ] Click "Export to Excel" — verify file opens correctly

### 13.7 Running on VPS (Production)

**Recommended VPS:** DigitalOcean Droplet or AWS EC2 — `t3.small` or equivalent (2 vCPU, 2GB RAM minimum, 4GB recommended for Playwright).

```bash
# On VPS: install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install pm2 globally
npm install -g pm2

# Clone project and install dependencies
git clone <your-repo> /srv/lead-scraper
cd /srv/lead-scraper/backend
npm install
npx playwright install chromium --with-deps   # also installs system deps for Chromium
npm run build

# Configure environment
cp .env.example .env
nano .env   # fill in API keys, set NODE_ENV=production

# Start with pm2
npm run start:pm2

# Save pm2 config and enable startup
pm2 save
pm2 startup   # follow the output instructions to auto-start on reboot

# Monitor
pm2 logs lead-scraper
pm2 monit
```

**Serve frontend (options):**
- Build Next.js: `cd frontend && npm run build && npm start` (port 3000), serve via nginx reverse proxy.
- Or deploy frontend to Vercel (static + API calls to your VPS backend). Update `NEXT_PUBLIC_API_URL` to your VPS IP/domain.

**nginx config (optional, for domain + SSL):**
```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location /api/ {
        proxy_pass http://localhost:4000;
        proxy_http_version 1.1;
        proxy_set_header Connection '';           # Required for SSE
        proxy_buffering off;                      # Required for SSE
        proxy_cache off;                          # Required for SSE
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
    }
}
```

The `proxy_buffering off` line is critical — without it, nginx buffers SSE events and the live table will not update.

### 13.8 Verifying the Installation

Run this quick sanity check before the first real scrape:

```bash
# Test Outscraper API key
curl "https://api.app.outscraper.com/maps/search?query=coffee+shop+London&limit=3" \
  -H "X-API-KEY: $OUTSCRAPER_API_KEY"
# Expect: JSON array with 3 business objects

# Test Geocoding API key
curl "https://maps.googleapis.com/maps/api/geocode/json?address=London,UK&key=$GOOGLE_GEOCODING_API_KEY"
# Expect: status "OK" with results array

# Test Playwright browser
node -e "
const { chromium } = require('playwright');
chromium.launch({ headless: true }).then(b => {
  console.log('Playwright OK, browser version:', b.version());
  return b.close();
});
"
# Expect: "Playwright OK, browser version: X.X.X"
```

### 13.9 Common Issues & Fixes

| Issue | Cause | Fix |
|-------|-------|-----|
| `Error: browserType.launch: Executable doesn't exist` | Playwright browser not installed | Run `npx playwright install chromium` |
| `OUTSCRAPER_API_KEY is not defined` | `.env` not loaded | Ensure `dotenv.config()` is called at the top of `server.ts` |
| SSE stream not updating in browser | nginx buffering | Add `proxy_buffering off` to nginx config |
| CAPTCHA detected immediately on Google Maps | Headless fingerprint | Switch to Outscraper as primary (should be default); or add stealth plugin |
| Phone numbers not normalizing | Missing country code | Check geocode step returns ISO code; verify `defaultRegion` is passed to `libphonenumber-js` |
| Chromium OOM crash on VPS | Insufficient RAM | Upgrade to 4GB RAM; reduce `CONCURRENCY_MAX` to 1 in `.env` |
| Export produces empty file | Job not completed | Wait for job to finish or stop it before exporting |
| `net::ERR_CERT_INVALID` on some sites | Self-signed SSL on target | Add `ignoreHTTPSErrors: true` to Playwright launch options |

---

## 14. Phased Build Plan

**Phase 1 — MVP: Discovery + Filter + Export**
- Keyword/location input with geocode validation **(with retry fallback on cleaned query)**.
- Outscraper API call → raw business list (name, address, phone, website).
- In-memory dedup (`Set` on `normalizedPhone|rootDomain` **via `tldts`**).
- Filter: discard leads with no email AND no phone **— runs ONLY after all scraping steps**.
- In-memory `leads[]` array with `store.ts` module **+ failure metrics counters**.
- SSE endpoint **with per-jobId connection tracking** + React `EventSource` client.
- Live results table (5 columns).
- Status bar with lead count and discard count.
- `POST /api/stop` with drain, **10s hard timeout, force-close browser contexts**, preserve array.
- `GET /api/export` → Excel download with sort and green highlighting **+ streaming writer prep for >500 leads**.

**Phase 2 — Website Scraping (Homepage)**
- Crawlee + Playwright integration for detail scraping.
- **Dynamic scraping strategy**: detect static vs JS-heavy pages, use Cheerio for static, Playwright for dynamic.
- Homepage fetch per lead with a website URL.
- Email extraction **(hardened: extended blacklist, freemail handling, noise filtering)**.
- Phone refinement (libphonenumber-js + ISO country hint from geocode).
- **Lead quality tier assignment** (Tier1/Tier2/Tier3 — internal only).
- Re-evaluate filter after website scrape — leads that had no phone from discovery may gain one from their website.

**Phase 3 — In-Depth Crawl**
- In-depth depth toggle activates sub-page following.
- Follow `/contact`, `/about`, `/team` links (max 4 per site, 1 hop from homepage).
- Cheerio used for confirmed static sub-pages (faster than Playwright).

**Phase 4 — Anti-Blocking**
- Crawlee `SessionPool` for UA rotation.
- Per-source rate limits from §9 table.
- Stealth plugin for Maps fallback.
- Proxy fallback logic (none → free → paid).
- CAPTCHA detection + SSE warning event.
- `RESPECT_ROBOTS_TXT` env flag wired in.

**Phase 5 — Compliance & Operations**
- Compliance notice in UI footer.
- Winston logging to file.
- pm2 configuration and nginx setup (if VPS).
- `robots-parser` integration.

**Phase 6 — Future Enhancements**
- Playwright fallback for Google Maps (if Outscraper proves insufficient long-term).
- Multi-city batch input (comma-separated locations or file upload).
- Directory fallbacks: Yelp, YellowPages, Justdial, IndiaMart.
- Scheduled runs via `node-cron`.
- Optional SQLite persistence if history/re-export across sessions becomes a need.
- CRM auto-import (HubSpot, Pipedrive, Zoho API).

---

## 15. Assumptions & Open Questions

**Confirmed decisions (not open):**
- Storage: none (in-memory only).
- Export format: Excel (.xlsx) only.
- Filter rule: discard if no email AND no phone.
- Sort rule: both-contact leads first, green highlight.
- Contact name/title: out of scope.
- Primary discovery: Outscraper API.
- Live updates: SSE.

**Remaining open questions:**

**Outscraper quota:** If 500/month free limit is consistently hit, the overage cost is ~$1.50 per additional 500 leads at $3/1k. Confirm this is acceptable before going beyond MVP.

**Filter timing:** ~~RESOLVED.~~ The filter now runs ONLY after all scraping steps are complete (discovery + website scraping + phone normalization + email extraction). No leads are discarded during the discovery stage. This is implemented as described in Step 8 of §3.

**Website scraping success rate:** Expect email extraction to succeed on approximately 30–50% of business websites (many don't publish email publicly or use contact forms). Phone success rate is higher (60–70%) as Outscraper usually provides it from Maps data.

**GDPR in practice:** For EU leads, the outreach team must apply appropriate rules (documented lawful basis, opt-out). The scraper flags no region-specific warnings — this is the team's responsibility.

**Multi-location support:** Not in scope for MVP but the architecture supports it. A batch input UI + loop over `discovery()` calls with separate dedup sets per location would work cleanly.

---

## 16. References & Resources

| Resource | URL | Purpose |
|----------|-----|---------|
| Crawlee | https://crawlee.dev | Primary crawler framework |
| Playwright | https://playwright.dev | Headless browser |
| Outscraper | https://outscraper.com | Google Maps data API |
| Outscraper API Docs | https://app.outscraper.com/api-docs | API reference |
| Google Places API | https://developers.google.com/maps/documentation/places | Official Maps data (alternative) |
| Google Geocoding API | https://developers.google.com/maps/documentation/geocoding | Location validation + ISO code |
| libphonenumber-js | https://www.npmjs.com/package/libphonenumber-js | Phone normalization |
| exceljs | https://www.npmjs.com/package/exceljs | Excel file generation |
| Cheerio | https://cheerio.js.org | Static HTML parsing |
| tldts | https://www.npmjs.com/package/tldts | Root domain extraction for dedup + email matching |
| robots-parser | https://www.npmjs.com/package/robots-parser | robots.txt compliance |
| puppeteer-extra-plugin-stealth | https://www.npmjs.com/package/puppeteer-extra-plugin-stealth | Headless fingerprint masking |
| winston | https://www.npmjs.com/package/winston | Logging |
| pm2 | https://pm2.keymetrics.io | VPS process management |
| Next.js | https://nextjs.org/docs | Frontend framework |
| CAN-SPAM Compliance | https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business | US email law |
| GDPR (ICO) | https://ico.org.uk/for-organisations/direct-marketing | EU/UK email guidance |
| ProxyScrape | https://proxyscrape.com | Free proxy lists (use cautiously) |

---

*This document is the single authoritative reference for the lead-generation scraper system. All architectural decisions are committed. Implementation can begin at Phase 1 without further design work.*
