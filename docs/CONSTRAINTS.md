# Non-Negotiable Constraints

> These rules are fixed. They must not be changed without explicit sign-off.
> Any implementation that violates these constraints is incorrect.

---

## 1. No Email Guessing

**Rule:** The System SHALL only use emails that are literally scraped from a web page.

- Domain-pattern generation (e.g. `info@<domain>`, `contact@<domain>`) is **forbidden**.
- If no email is found on the page after all extraction and filtering steps, the email field is left as an empty string.
- No third-party email-finding APIs (Hunter.io, etc.) are permitted.

---

## 2. No Persistent Storage

**Rule:** All lead data lives in the Node.js process memory only.

- No database writes (SQL, NoSQL, or otherwise).
- No file writes to disk (no JSON, CSV, or any format).
- No external caching services (Redis, Memcached, etc.).
- Restarting the server clears all data. The operator must export before restarting.
- Starting a new job calls `store.reset()`, which clears all data from the previous job.

---

## 3. No Bounce Verification

**Rule:** Scraped emails are not validated for deliverability.

- No SMTP probing.
- No third-party email verification APIs.
- Emails are stored and exported as-is after the extraction and blacklist filtering steps.

---

## 4. Phone Numbers in E.164 Format

**Rule:** Every stored phone number must be in E.164 international format.

- Format: `+<country_code><number>`, e.g. `+919876543210`, `+12025551234`.
- Normalisation is performed by `libphonenumber-js` using the ISO 3166-1 alpha-2 country code extracted from the location input as `defaultRegion`.
- A phone number that `libphonenumber-js` cannot validate as a real number for the given region is discarded (field left as empty string).
- Raw, unformatted phone strings must never appear in the `leads[]` array or the export.

---

## 5. Filter Runs Post-Scrape Only

**Rule:** Leads are never discarded during the discovery stage.

- A business with no phone from Outscraper may still gain a phone from its website.
- The filter (`email || phone` check) runs **only after** all of the following are complete for a lead:
  1. Discovery
  2. Website scraping (if a website URL exists)
  3. Phone normalisation
  4. Email extraction
- Discarding a lead before all scraping steps are complete is a bug.

---

## 6. Stop Must Terminate Within 10 Seconds

**Rule:** `POST /api/stop` must result in full job termination within 10 seconds.

- The Stop_Handler signals Crawlee to stop accepting new requests.
- It waits for in-flight pages to finish naturally.
- After 10 seconds, it **force-closes all Playwright browser contexts** regardless of in-flight state.
- The `leads[]` array is preserved after stop — export still works.
- Job status is set to `stopped`.

---

## 7. Deduplication Key Format

**Rule:** The dedup key is `${normalizedPhone}|${rootDomain}`.

- `normalizedPhone`: E.164 format (or empty string if no phone).
- `rootDomain`: extracted via the `tldts` library from the website URL. This correctly handles subdomains and multi-part TLDs (`.co.uk`, `.com.au`, `.org.in`).
- If both `normalizedPhone` and `rootDomain` are empty, the entry passes through without deduplication (no key can be formed).
- The dedup `Set` is scoped to a single job run and cleared on `store.reset()`.

---

## 8. Volume and Scope

**Rule:** Each job targets a single location and requests up to 100 raw businesses.

- Single-location queries only — no multi-location batching per run.
- Target: ~100 raw leads per run, ~50–80 qualifying after filter.
- Global coverage — any location resolvable by the Geocoding API is valid.

---

## 9. Export Format

**Rule:** The only export format is `.xlsx` (Excel).

- No CSV, JSON, PDF, or other formats.
- No field picker — the export always contains: Business Name, Email, Phone, Website, Address.
- One Export button. No configuration.
- Internal fields (`_hasBoth`, `_qualityTier`) are never included in the export.

---

## 10. LinkedIn Exclusion

**Rule:** LinkedIn is excluded from all discovery sources in all phases.

- LinkedIn detects automation aggressively and has litigated against scrapers.
- No LinkedIn scraping, API calls, or data sourcing of any kind.

---

## 11. Deployment Constraint

**Rule:** The System must run on a local machine or VPS with persistent processes.

- Vercel serverless is not suitable — headless browsers (Playwright/Chromium) require long-lived processes.
- Any deployment target must support Node.js 20 LTS and Playwright Chromium.

---

## 12. Public Data Only

**Rule:** The System only scrapes publicly accessible web pages.

- No login-gated pages.
- No pages requiring authentication or session cookies.
- If a website redirects to a login or auth page, the website is marked as unreachable and skipped.

---

## 13. No Paid APIs

**Rule:** The System must use only free, zero-cost services for all data acquisition.

- **Geocoding:** OpenStreetMap Nominatim (`https://nominatim.openstreetmap.org/search`) — free, no API key required.
- **Discovery:** Playwright on Google Maps — free, no Outscraper API, no Google Places API.
- No paid proxy services unless explicitly approved (budget: $5–6/month maximum, only if persistent blocks occur).
- No Hunter.io, Clearbit, or any paid enrichment API.

---

## 14. Discovery Must Use Playwright on Google Maps

**Rule:** Business discovery is performed exclusively by Playwright navigating Google Maps.

- URL pattern: `https://www.google.com/maps/search/<keyword>+<location>`
- Scroll the `[role="feed"]` until ~100 results are loaded or no new results appear.
- Click each result card to open the detail panel and extract: name, address, phone, website.
- Apply 2–4 second delays with ±500ms random jitter between card interactions.
- On CAPTCHA detection: increment `captcha_blocked` metric, emit SSE `error` event, stop discovery safely.
- LinkedIn is excluded from all discovery sources in all phases.
