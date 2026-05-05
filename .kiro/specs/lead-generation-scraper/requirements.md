# Requirements Document

## Introduction

The Lead Generation Scraper is an in-house tool for email marketing and cold-calling teams. Given a keyword (business type) and a location, it discovers up to 100 businesses, enriches each with email and phone contact data scraped from their websites, filters out leads with no contact method, and delivers a sorted, highlighted Excel file. All data is held in memory for the duration of the session — no database is involved. The system streams live results to the operator's browser via Server-Sent Events while the job runs.

---

## Glossary

- **System**: The Lead Generation Scraper application as a whole (frontend + backend).
- **Dashboard**: The Next.js 14 frontend UI served to the operator.
- **API**: The Express 4 backend that handles all HTTP endpoints.
- **Geocoder**: The external Geocoding API integration that validates location strings and extracts ISO country codes.
- **Discovery_Module**: The component that queries Outscraper API (primary) or Playwright on Google Maps (fallback) to obtain a raw list of businesses.
- **Deduplicator**: The in-memory component that removes duplicate businesses within a single job run using a `normalizedPhone|rootDomain` key.
- **Detail_Scraper**: The component that visits each business website to extract email and phone data.
- **Static_Detector**: The sub-component of Detail_Scraper that determines whether a page is static (Cheerio) or dynamic (Playwright).
- **Email_Extractor**: The sub-component that extracts and ranks email addresses from page content.
- **Phone_Normalizer**: The sub-component that normalises phone numbers to E.164 format using `libphonenumber-js`.
- **Filter**: The post-scrape component that discards leads with neither email nor phone.
- **Quality_Tier**: An internal classification — Tier 1 (email + phone), Tier 2 (email only), Tier 3 (phone only).
- **Store**: The in-memory `leads[]` array and associated counters that hold all session data.
- **SSE_Endpoint**: The `GET /api/stream` Server-Sent Events endpoint that pushes real-time events to the Dashboard.
- **Exporter**: The component that generates and streams the `.xlsx` file on demand.
- **Stop_Handler**: The component that gracefully terminates a running job within a hard 10-second timeout.
- **Job**: A single scrape run initiated by the operator with a keyword, location, and depth setting.
- **Lead**: A qualifying business record with at least one contact method (email or phone).
- **Raw_Lead**: A business record returned by Discovery_Module before filtering.
- **E.164**: International phone number format, e.g. `+919876543210`.
- **Root_Domain**: The registrable domain extracted from a URL via `tldts`, e.g. `example.co.uk` from `www.shop.example.co.uk`.
- **Depth**: The scraping depth setting — `homepage` (homepage only) or `indepth` (homepage + up to 4 sub-pages).

---

## Requirements

### Requirement 1: Job Input and Location Validation

**User Story:** As an operator, I want to specify a keyword, location, and depth before starting a job, so that the System targets the right businesses in the right place.

#### Acceptance Criteria

1. THE Dashboard SHALL provide a text input for a keyword, a text input for a location, and a toggle for Depth (`homepage` or `indepth`).
2. WHEN the operator submits a job, THE API SHALL send the location string to the Geocoder before initiating any scraping activity.
3. WHEN the Geocoder resolves the location successfully, THE API SHALL extract the ISO 3166-1 alpha-2 country code and store it in the job context for use by the Phone_Normalizer throughout the run.
4. IF the initial Geocoder request fails, THEN THE API SHALL retry with a cleaned query (trimmed whitespace, removed special characters, normalised encoding) before returning an error.
5. IF the location remains unresolvable after the retry, THEN THE API SHALL return a validation error to the Dashboard within 10 seconds and SHALL NOT initiate any scraping activity.
6. THE Dashboard SHALL display the Geocoder validation error message to the operator when location validation fails.

---

### Requirement 2: Business Discovery

**User Story:** As an operator, I want the System to discover up to 100 businesses matching my keyword and location, so that I have a broad pool of leads to enrich.

#### Acceptance Criteria

1. WHEN a job starts with a valid location, THE Discovery_Module SHALL query the Outscraper API with the keyword and location, requesting up to 100 results.
2. THE Discovery_Module SHALL extract business name, formatted address, raw phone, website URL, and place ID from each Outscraper response record.
3. IF the Outscraper API returns a non-200 response or a quota-exceeded error, THEN THE Discovery_Module SHALL automatically fall back to Playwright navigating Google Maps and extract equivalent fields.
4. WHILE the Playwright fallback is active, THE Discovery_Module SHALL throttle requests with a 2–4 second delay and ±500ms random jitter between each business detail panel interaction.
5. THE Discovery_Module SHALL keep all Raw_Leads returned from discovery, including entries that have no phone and no website URL.
6. THE Discovery_Module SHALL pass all Raw_Leads to the Deduplicator before any website scraping begins.

---

### Requirement 3: Deduplication

**User Story:** As an operator, I want duplicate businesses removed before scraping, so that the System does not waste time scraping the same business twice in one run.

#### Acceptance Criteria

1. THE Deduplicator SHALL maintain an in-memory `Set<string>` per job, cleared at the start of each new job.
2. WHEN processing a Raw_Lead, THE Deduplicator SHALL build a dedup key of the form `${normalizedPhone}|${rootDomain}`, where Root_Domain is extracted from the website URL using the `tldts` library.
3. IF a Raw_Lead's dedup key already exists in the Set, THEN THE Deduplicator SHALL skip that entry and increment the `duplicate_skipped` failure metric counter.
4. IF a Raw_Lead has neither a phone nor a website URL, THEN THE Deduplicator SHALL pass it through without deduplication, as no key can be formed.
5. THE Deduplicator SHALL correctly handle multi-part TLDs (e.g. `.co.uk`, `.com.au`) and subdomains when extracting Root_Domain.

---

### Requirement 4: Website Scraping — Static Detection

**User Story:** As a developer, I want the Detail_Scraper to choose the lightest viable scraping method per page, so that the System processes static pages faster without launching a full browser.

#### Acceptance Criteria

1. WHEN the Detail_Scraper processes a business with a website URL, THE Static_Detector SHALL send a GET request to the URL with a 2-second timeout to inspect the response HTML.
2. WHEN the response arrives within 2 seconds and contains none of the JS framework markers (`__NEXT_DATA__`, `react`, `vue`, `angular`, `ng-version`, `nuxt`, `__NUXT__`, `svelte`, `gatsby`), THE Static_Detector SHALL classify the page as `static`.
3. WHEN the response contains at least one JS framework marker or the request exceeds 2 seconds, THE Static_Detector SHALL classify the page as `dynamic`.
4. WHEN a page is classified as `static`, THE Detail_Scraper SHALL parse the already-fetched HTML using Cheerio.
5. WHEN a page is classified as `dynamic`, THE Detail_Scraper SHALL fetch the page using Playwright with `waitUntil: 'networkidle'`.
6. IF the website returns an HTTP 4xx or 5xx status, redirects to a login or authentication page, or times out after 15 seconds, THEN THE Detail_Scraper SHALL mark the lead as `website_unreachable`, increment the `website_unreachable` failure metric counter, and continue processing the lead using only discovery-phase data.

---

### Requirement 5: Website Scraping — Depth Control

**User Story:** As an operator, I want to choose between homepage-only and in-depth scraping, so that I can trade off speed against contact data completeness.

#### Acceptance Criteria

1. WHEN Depth is set to `homepage`, THE Detail_Scraper SHALL extract email and phone from the homepage HTML only.
2. WHEN Depth is set to `indepth`, THE Detail_Scraper SHALL first extract from the homepage, then scan `<a>` tags for internal links whose pathname starts with `/contact`, `/contact-us`, `/about`, `/about-us`, `/team`, `/staff`, or `/leadership`.
3. WHILE operating in `indepth` mode, THE Detail_Scraper SHALL follow a maximum of 4 matched internal sub-page links per business, with no recursive crawl beyond 1 hop from the homepage.
4. WHILE operating in `indepth` mode, THE Detail_Scraper SHALL only follow links whose hostname matches the base domain of the business website (no external links).

---

### Requirement 6: Email Extraction

**User Story:** As an operator, I want the System to extract only genuine business contact emails, so that the lead list is not polluted with infrastructure, analytics, or freemail addresses.

#### Acceptance Criteria

1. WHEN extracting emails from a page, THE Email_Extractor SHALL collect addresses from `<a href="mailto:...">` elements first, then supplement with a regex scan of visible body text (`/[\w.+\-]+@[\w\-]+\.[\w.]{2,}/g`).
2. THE Email_Extractor SHALL deduplicate the combined email list (case-insensitive) before applying any filters.
3. THE Email_Extractor SHALL discard any email whose address or domain contains any of the following blacklist terms: `noreply`, `no-reply`, `donotreply`, `do-not-reply`, `example.com`, `sentry`, `cloudflare`, `amazonaws`, `google`, `facebook`, `wixpress.com`.
4. THE Email_Extractor SHALL discard any email whose local part exceeds 50 characters or matches noise patterns (`webpack@`, `sourcemap@`, `tracking@`, `pixel@`, `analytics@`, `error@`).
5. THE Email_Extractor SHALL prefer emails whose domain matches the company's Root_Domain over non-company-domain emails, and SHALL use freemail addresses (gmail.com, yahoo.com, outlook.com, hotmail.com, aol.com, icloud.com, mail.com, protonmail.com, yandex.com, zoho.com) only as a last resort when no other email survives filtering.
6. THE Email_Extractor SHALL store exactly one email per lead — the highest-priority surviving candidate.
7. THE System SHALL NOT generate or guess email addresses using domain patterns. Only scraped emails are permitted.
8. IF no email survives filtering for a lead, THEN THE Email_Extractor SHALL increment the `email_not_found` failure metric counter and leave the email field as an empty string.

---

### Requirement 7: Phone Extraction and Normalisation

**User Story:** As an operator, I want all phone numbers in E.164 format, so that the cold-calling team can dial them directly without reformatting.

#### Acceptance Criteria

1. WHEN a Raw_Lead already contains a phone number from the Discovery_Module, THE Phone_Normalizer SHALL use that number as the primary source and normalise it to E.164 format using `libphonenumber-js` with the ISO country code from the job context as `defaultRegion`.
2. WHEN a Raw_Lead has no discovery-phase phone, THE Phone_Normalizer SHALL scan the page text using phone regex patterns (`\+[\d\s\-().]{7,20}`, `\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}`, `\d{8,15}`) and normalise the first valid match to E.164.
3. THE Phone_Normalizer SHALL only store a phone number that `libphonenumber-js` validates as a valid number for the given region.
4. IF no valid phone number is found for a lead, THEN THE Phone_Normalizer SHALL increment the `phone_not_found` failure metric counter and leave the phone field as an empty string.

---

### Requirement 8: Post-Scrape Filter

**User Story:** As an operator, I want leads without any contact method removed automatically, so that the exported file contains only actionable records.

#### Acceptance Criteria

1. THE Filter SHALL run only after all scraping steps are complete for a lead (discovery + website scraping + phone normalisation + email extraction). THE Filter SHALL NOT discard leads during the discovery stage.
2. WHEN a lead has neither an email nor a phone after all scraping steps, THE Filter SHALL discard the lead, increment the `discard_no_contact` failure metric counter, emit an SSE `discard` event, and log the business name and reason.
3. THE Filter SHALL NOT include discarded leads in the `leads[]` Store or in any export.
4. THE Dashboard SHALL display a running discard count that updates in real time as `discard` SSE events are received.

---

### Requirement 9: Quality Tier Assignment

**User Story:** As an operator, I want leads ranked by contact completeness, so that the export prioritises the most actionable records.

#### Acceptance Criteria

1. WHEN a lead passes the Filter, THE System SHALL assign an internal Quality_Tier: Tier 1 if both email and phone are present, Tier 2 if only email is present, Tier 3 if only phone is present.
2. THE System SHALL set the `_hasBoth` flag to `true` for Tier 1 leads and `false` for Tier 2 and Tier 3 leads.
3. THE System SHALL NOT include `_qualityTier` or `_hasBoth` fields in the Excel export or in SSE `lead` event payloads sent to the Dashboard.

---

### Requirement 10: In-Memory Store

**User Story:** As a developer, I want all session data held in memory only, so that no lead data persists beyond the current server process.

#### Acceptance Criteria

1. THE Store SHALL hold all qualified leads in a TypeScript `Lead[]` array for the duration of the server process.
2. WHEN a new job starts, THE Store SHALL call `reset()`, clearing the `leads[]` array, discard count, job status, and all failure metric counters.
3. THE Store SHALL NOT write any lead data to disk, a database, or any external service.
4. WHEN the server process restarts, THE Store SHALL initialise empty, with no data from previous sessions.

---

### Requirement 11: Real-Time Streaming via SSE

**User Story:** As an operator, I want to see leads appear in the Dashboard as they are found, so that I can monitor job progress without waiting for the full run to complete.

#### Acceptance Criteria

1. THE SSE_Endpoint SHALL accept `GET /api/stream` connections and push events using the Server-Sent Events protocol.
2. WHEN a lead passes the Filter and is pushed to the Store, THE SSE_Endpoint SHALL immediately emit a `lead` event containing the lead's public fields (businessName, email, phone, website, address).
3. WHEN a lead is discarded by the Filter, THE SSE_Endpoint SHALL emit a `discard` event containing the updated stats (leadCount, discardCount, jobStatus).
4. THE SSE_Endpoint SHALL also emit `status` events when job status changes and `error` events when a non-recoverable error occurs.
5. THE SSE_Endpoint SHALL track open connections per `jobId`. WHEN a new connection is opened for a `jobId` that already has an active connection, THE SSE_Endpoint SHALL close the previous connection.
6. WHEN a job stops or completes, THE SSE_Endpoint SHALL close all SSE connections associated with that job to prevent memory leaks.

---

### Requirement 12: Job Control — Start and Stop

**User Story:** As an operator, I want to start and stop scrape jobs from the Dashboard, so that I can abort a run early and still export whatever leads have been collected.

#### Acceptance Criteria

1. WHEN the operator clicks Start, THE Dashboard SHALL POST to `/api/start` with the keyword, location, and depth parameters.
2. THE API SHALL expose `POST /api/start`, `POST /api/stop`, `GET /api/status`, `GET /api/stream`, and `GET /api/export` endpoints.
3. WHEN the operator clicks Stop, THE Stop_Handler SHALL signal Crawlee to stop accepting new requests and wait for in-flight pages to finish.
4. THE Stop_Handler SHALL enforce a hard timeout of 10 seconds. WHEN the timeout expires, THE Stop_Handler SHALL force-close all Playwright browser contexts regardless of in-flight state.
5. WHEN a job is stopped, THE Stop_Handler SHALL set job status to `stopped` and SHALL preserve the `leads[]` array so that the operator can still export collected leads.
6. THE Dashboard SHALL display the current job status (`idle`, `running`, `stopped`, `completed`, `error`) at all times.

---

### Requirement 13: Excel Export

**User Story:** As an operator, I want to download all qualifying leads as a single Excel file, so that I can hand it off to the email marketing and cold-calling teams.

#### Acceptance Criteria

1. WHEN the operator clicks Export, THE Exporter SHALL respond to `GET /api/export` by generating a `.xlsx` file and streaming it to the browser as a file download.
2. THE Exporter SHALL sort leads so that Tier 1 leads (both email and phone) appear first, followed by Tier 2 and Tier 3 leads.
3. THE Exporter SHALL apply green row highlighting to all Tier 1 leads in the Excel worksheet.
4. THE Exporter SHALL include exactly the following columns in the worksheet: Business Name, Email, Phone, Website, Address.
5. THE Exporter SHALL NOT include the `_qualityTier` or `_hasBoth` internal fields in the exported file.
6. WHERE the lead count exceeds 500, THE Exporter SHALL use a streaming writer internally to avoid memory spikes, with no change to the operator-facing behaviour.
7. THE Exporter SHALL NOT modify the `leads[]` array during or after export.
8. THE Export button SHALL remain available when job status is `stopped` or `completed`, so that the operator can export a partial result after stopping a job early.

---

### Requirement 14: Failure Metrics and Logging

**User Story:** As a developer, I want structured failure metrics and logs, so that I can diagnose scraping quality issues and tune the pipeline.

#### Acceptance Criteria

1. THE Store SHALL maintain counters for the following failure metrics: `discard_no_contact`, `website_unreachable`, `email_not_found`, `phone_not_found`, `duplicate_skipped`, `captcha_blocked`.
2. WHEN any pipeline step triggers a failure condition, THE System SHALL increment the corresponding failure metric counter.
3. THE API SHALL expose the current failure metrics via `GET /api/status` alongside the lead count, discard count, and job status.
4. THE System SHALL log all discard events, website-unreachable events, and job lifecycle transitions using `winston` at the appropriate log level.
5. THE System SHALL NOT log any personally identifiable information beyond business name and website URL.

---

### Requirement 15: Anti-Blocking and Reliability

**User Story:** As an operator, I want the scraper to handle bot-detection measures gracefully, so that a single blocked request does not abort the entire job.

#### Acceptance Criteria

1. THE Discovery_Module SHALL use Crawlee's built-in request fingerprint rotation and concurrency control for all Playwright-based requests.
2. WHEN a website scraping request is blocked or returns a CAPTCHA response, THE Detail_Scraper SHALL increment the `captcha_blocked` failure metric counter, skip that business's website, and continue processing remaining leads.
3. IF the Outscraper API is unavailable, THEN THE Discovery_Module SHALL fall back to the Playwright Google Maps path without operator intervention.
4. THE Detail_Scraper SHALL apply a per-request timeout of 15 seconds for website scraping. WHEN the timeout is exceeded, THE Detail_Scraper SHALL treat the website as unreachable and continue.

---

### Requirement 16: Context Documentation

**User Story:** As a developer, I want implementation context documents in the repository, so that any developer can understand the system architecture, constraints, and progress without reading the full blueprint.

#### Acceptance Criteria

1. THE System repository SHALL contain `/docs/IMPLEMENTATION_CONTEXT.md` describing the system summary, architecture, pipeline steps, critical rules, phase breakdown, and folder structure.
2. THE System repository SHALL contain `/docs/PROGRESS.md` with a phase checklist, the current active phase, and the status of each module (completed or pending).
3. THE System repository SHALL contain `/docs/CONSTRAINTS.md` listing all non-negotiable rules (no email guessing, no storage, no bounce verification, E.164 phone format, 10-second stop timeout, filter runs post-scrape only, in-memory dedup key format).
4. WHEN any non-negotiable constraint is updated, THE corresponding entry in `/docs/CONSTRAINTS.md` SHALL be updated to reflect the change.
