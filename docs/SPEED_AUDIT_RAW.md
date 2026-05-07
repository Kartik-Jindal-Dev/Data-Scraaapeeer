# Speed Audit: Backend Scraping Pipeline Performance Bottlenecks

**Date:** May 6, 2026  
**Scope:** Backend scraping pipeline (backend/src/pipeline/)  
**Focus:** Performance bottlenecks, scalability limitations, throughput constraints

## Executive Summary

The pipeline exhibits several critical bottlenecks that limit scraping throughput and scalability. The most severe issues are **sequential city job execution**, **blocking DNS/MX lookups**, **inefficient retry logic**, and **memory-intensive operations**. Current configuration allows only 3 concurrent website scrapes per city, with cities processed one at a time.

---

## 1. Concurrency Bottlenecks

### 1.1 Sequential City Job Execution

**Bottleneck:** City jobs execute sequentially, not concurrently
**Root Cause:** `pipeline.ts` processes one city at a time; `SCRAPE_CONCURRENCY` only applies within a single city
**Estimated Impact:** 80-90% idle time when scraping multiple cities
**Suggested Optimization:** Implement parallel city job execution with separate browser contexts
**Risk Level:** High (requires architectural changes)
**Files Involved:** `pipeline.ts`, `start.ts` (controller)

### 1.2 Limited Intra-City Concurrency

**Bottleneck:** Maximum 6 concurrent website scrapes per city (clamped from env)
**Root Cause:** `SCRAPE_CONCURRENCY` env var with hard cap of 6
**Estimated Impact:** 50% throughput reduction vs. potential 10-12 concurrent
**Suggested Optimization:** Increase cap to 10-12 with proper resource management
**Risk Level:** Medium (blocking risk)
**Files Involved:** `pipeline.ts` (lines 45-55)

### 1.3 Single Browser Context for Scraping

**Bottleneck:** All website scraping shares one browser context
**Root Cause:** `scraper.ts` uses singleton `scraperBrowser`/`scraperContext`
**Estimated Impact:** Context switching overhead, single point of failure
**Suggested Optimization:** Browser pool with isolated contexts per concurrent scrape
**Risk Level:** Medium (resource management complexity)
**Files Involved:** `scraper.ts` (lines 40-70)

---

## 2. Sequential Processing Bottlenecks

### 2.1 Batch-Wait-Process Pattern

**Bottleneck:** Each batch must complete scraping before extraction/filtering begins
**Root Cause:** `Promise.all()` for scraping, then sequential processing loop
**Estimated Impact:** 30-40% pipeline idle time within batches
**Suggested Optimization:** Streaming pipeline: process leads as they complete scraping
**Risk Level:** Low (non-breaking change)
**Files Involved:** `pipeline.ts` (lines 130-190)

### 2.2 Synchronous Deduplication

**Bottleneck:** Deduplication runs synchronously before any scraping
**Root Cause:** `for` loop checking each raw lead sequentially
**Estimated Impact:** Minimal for 100 leads, scales poorly to 1000+
**Suggested Optimization:** Parallel dedup checks or pre-filtering
**Risk Level:** Low
**Files Involved:** `pipeline.ts` (lines 100-110), `deduplicator.ts`

### 2.3 Sequential Email/Phone Extraction

**Bottleneck:** Email then phone extraction runs sequentially per lead
**Root Cause:** `await extractEmail()` then `extractPhone()` in same loop iteration
**Estimated Impact:** 20-30ms per lead wasted on sequential async operations
**Suggested Optimization:** Parallel extraction: `Promise.all([extractEmail, extractPhone])`
**Risk Level:** Low
**Files Involved:** `pipeline.ts` (lines 170-175)

---

## 3. Blocking Operations

### 3.1 DNS Pre-Resolution Blocking

**Bottleneck:** Synchronous DNS lookup before each scrape
**Root Cause:** `dns.resolve()` in `scrapePage()` blocks until resolution
**Estimated Impact:** 50-200ms per website, multiplied by concurrency limit
**Suggested Optimization:** Async DNS with timeout or remove pre-check (robots.txt already validates)
**Risk Level:** Medium (may increase unreachable rate)
**Files Involved:** `scraper.ts` (lines 200-210)

### 3.2 MX Record Validation Blocking

**Bottleneck:** DNS MX lookup for every email candidate
**Root Cause:** `dns.resolveMx()` in `isEmailDomainValid()` with caching
**Estimated Impact:** 100-500ms per email validation, serialized per lead
**Suggested Optimization:** Batch MX lookups or remove validation (bounce risk acceptable)
**Risk Level:** Medium (quality impact)
**Files Involved:** `emailExtractor.ts` (lines 250-280)

### 3.3 Robots.txt Fetch Blocking

**Bottleneck:** HTTP fetch of robots.txt before each scrape (when enabled)
**Root Cause:** `isAllowedByRobots()` makes synchronous HTTP request
**Estimated Impact:** 300-1000ms per website when `RESPECT_ROBOTS_TXT=true`
**Suggested Optimization:** Domain-level robots.txt caching with TTL
**Risk Level:** Low
**Files Involved:** `robots.ts`, `scraper.ts` (line 195)

---

## 4. Unnecessary Waits

### 4.1 Fixed Scroll Pauses in Discovery

**Bottleneck:** `SCROLL_PAUSE_MS=1200` fixed wait between Google Maps scrolls
**Root Cause:** Hardcoded delay in `discovery.ts`
**Estimated Impact:** 3-6 seconds wasted per city discovery
**Suggested Optimization:** Dynamic waiting based on DOM readiness
**Risk Level:** Low
**Files Involved:** `discovery.ts` (line 20)

### 4.2 Random Delay for Fallback Navigation

**Bottleneck:** `REQUEST_DELAY_MS=800` + jitter for detail panel fallbacks
**Root Cause:** Anti-blocking measure but applied to all fallback navigations
**Estimated Impact:** 800-1200ms per fallback (only 10-20% of leads need it)
**Suggested Optimization:** Apply delay only when CAPTCHA risk detected
**Risk Level:** Medium (blocking risk)
**Files Involved:** `discovery.ts` (lines 30-35, 250-260)

### 4.3 Playwright Settle Time

**Bottleneck:** `page.waitForTimeout(600)` after page load
**Root Cause:** Fixed wait for JavaScript rendering
**Estimated Impact:** 600ms per website scrape
**Suggested Optimization:** Wait for specific selectors or network idle
**Risk Level:** Low
**Files Involved:** `scraper.ts` (line 155)

---

## 5. Duplicate Work

### 5.1 Repeated HTML Parsing

**Bottleneck:** Cheerio loads HTML 3+ times per lead (email, phone, contact form)
**Root Cause:** Separate `cheerio.load()` calls in each extraction module
**Estimated Impact:** 5-10ms CPU time per lead, memory churn
**Suggested Optimization:** Shared parsed DOM object passed between extractors
**Risk Level:** Low
**Files Involved:** `emailExtractor.ts`, `phoneNormalizer.ts`, `filter.ts`

### 5.2 Double JSON-LD Extraction

**Bottleneck:** `extractFromJsonLd()` called separately for email and phone
**Root Cause:** Phone extractor calls it again after email extractor already did
**Estimated Impact:** Redundant parsing of same JSON-LD blocks
**Suggested Optimization:** Single JSON-LD extraction with shared results
**Risk Level:** Low
**Files Involved:** `emailExtractor.ts` (lines 320-350), `phoneNormalizer.ts` (lines 90-100)

### 5.3 Repeated Root Domain Extraction

**Bottleneck:** `parseTld()` called multiple times for same URL
**Root Cause:** Email classification, dedup key building, filter all extract root domain
**Estimated Impact:** Redundant parsing overhead
**Suggested Optimization:** Compute once in RawLead and reuse
**Risk Level:** Low
**Files Involved:** `deduplicator.ts`, `emailExtractor.ts`, `filter.ts`

---

## 6. Memory-Heavy Flows

### 6.1 HTML Retention in Memory

**Bottleneck:** Full HTML stored in `ExtractedLead` and passed through pipeline
**Root Cause:** `html` field preserved for contact form detection
**Estimated Impact:** 50-200KB per lead × 100 leads = 10-20MB RAM bloat
**Suggested Optimization:** Process HTML immediately, discard after extraction
**Risk Level:** Low
**Files Involved:** `pipeline.ts`, `filter.ts`

### 6.2 In-Depth HTML Concatenation

**Bottleneck:** `mergedHtml` concatenates homepage + subpages with separators
**Root Cause:** `indepth.ts` joins all HTML strings with `<!-- PAGE_BREAK -->`
**Estimated Impact:** Memory spike for 5 subpages × 200KB = 1MB per lead
**Suggested Optimization:** Process pages independently, merge extracted data only
**Risk Level:** Medium (extraction logic changes)
**Files Involved:** `indepth.ts` (lines 120-130)

### 6.3 Rolling Window Map Growth

**Bottleneck:** `rollingWindow` Map grows indefinitely until 15-day expiry
**Root Cause:** No size limit or compaction
**Estimated Impact:** Memory leak potential in long-running processes
**Suggested Optimization:** LRU cache with max entries (e.g., 10,000)
**Risk Level:** Low
**Files Involved:** `deduplicator.ts` (lines 40-80)

---

## 7. Queue Inefficiencies

### 7.1 No Work Stealing Between Batches

**Bottleneck:** Fast leads wait for slow leads in same batch
**Root Cause:** `Promise.all()` on batch scraping synchronizes completion
**Estimated Impact:** Batch time = slowest lead × concurrency
**Suggested Optimization:** Worker pool with independent lead processing
**Risk Level:** Medium (complexity)
**Files Involved:** `pipeline.ts` (lines 130-140)

### 7.2 No Priority Queue for Leads

**Bottleneck:** All leads processed in discovery order
**Root Cause:** Simple array iteration
**Estimated Impact:** Missed opportunity to process high-value leads first
**Suggested Optimization:** Priority queue based on website presence/quality signals
**Risk Level:** Low
**Files Involved:** `pipeline.ts` (lines 100-110)

### 7.3 No Backpressure Management

**Bottleneck:** Unlimited batch processing without resource monitoring
**Root Cause:** No memory/CPU checks before starting new batches
**Estimated Impact:** OOM crashes under heavy load
**Suggested Optimization:** Adaptive batching based on system resources
**Risk Level:** Medium
**Files Involved:** `pipeline.ts` (lines 120-130)

---

## 8. Network Bottlenecks

### 8.1 No HTTP/2 or Connection Pooling

**Bottleneck:** Each Playwright request opens new TCP connection
**Root Cause:** Browser context doesn't reuse connections efficiently
**Estimated Impact:** 100-300ms TCP/TLS handshake per website
**Suggested Optimization:** Enable HTTP/2, connection reuse in Playwright
**Risk Level:** Low (Playwright configuration)
**Files Involved:** `antiBlocking.ts` (browser launch config)

### 8.2 No CDN or Geographic Optimization

**Bottleneck:** All requests originate from single IP/location
**Root Cause:** No proxy rotation or geographic distribution
**Estimated Impact:** Higher CAPTCHA rates, slower responses from distant servers
**Suggested Optimization:** Proxy rotation with geographic diversity
**Risk Level:** Medium (cost, complexity)
**Files Involved:** `antiBlocking.ts` (proxy config)

### 8.3 No Request Compression

**Bottleneck:** Full HTML transfer without compression
**Root Cause:** Playwright doesn't enable `Accept-Encoding: gzip` by default
**Estimated Impact:** 2-5x bandwidth waste, slower transfers
**Suggested Optimization:** Enable compression in browser context
**Risk Level:** Low
**Files Involved:** `antiBlocking.ts` (extra headers)

---

## 9. Retry Inefficiencies

### 9.1 Exponential Backoff Without Jitter

**Bottleneck:** `SCRAPE_RETRY_BASE_DELAY_MS=2000` with exponential growth
**Root Cause:** Fixed delays cause retry stampede if multiple failures
**Estimated Impact:** Wasted time on retry storms
**Suggested Optimization:** Add jitter to retry delays
**Risk Level:** Low
**Files Involved:** `scraper.ts` (lines 35-40, 220-240)

### 9.2 Retry on Non-Retryable Errors

**Bottleneck:** Retry loop continues even for permanent failures (4xx, DNS)
**Root Cause:** `isRetryableReason()` logic too permissive
**Estimated Impact:** Wasted retries on hopeless cases
**Suggested Optimization:** Distinguish transient vs. permanent failures
**Risk Level:** Low
**Files Involved:** `scraper.ts` (lines 180-200)

### 9.3 No Circuit Breaker Pattern

**Bottleneck:** Continuous retries on failing domains
**Root Cause:** No failure tracking per domain
**Estimated Impact:** Wasted time on consistently failing websites
**Suggested Optimization:** Circuit breaker with cooldown period
**Risk Level:** Low
**Files Involved:** `scraper.ts` (retry logic)

---

## 10. File/Database Write Overhead

### 10.1 Log File Synchronous Writes

**Bottleneck:** Winston logger writes to `./logs/scraper.log` synchronously
**Root Cause:** Default file transport configuration
**Estimated Impact:** I/O blocking during high-volume logging
**Suggested Optimization:** Async logging with buffering
**Risk Level:** Low
**Files Involved:** `logger.ts` (not in pipeline but affects performance)

### 10.2 GeoNames File Loading on Startup

**Bottleneck:** Synchronous `fs.readFileSync()` for cities15000.txt (15MB+)
**Root Cause:** `loadGeoNamesData()` blocks module initialization
**Estimated Impact:** 500-1000ms startup delay, memory bloat
**Suggested Optimization:** Lazy loading or memory-mapped files
**Risk Level:** Low
**Files Involved:** `cityPool.ts` (lines 60-120)

### 10.3 No Export Streaming

**Bottleneck:** Full leads array loaded into memory before Excel generation
**Root Cause:** `store.getLeads()` returns complete array
**Estimated Impact:** Memory spike during export of large datasets
**Suggested Optimization:** Stream leads directly to Excel writer
**Risk Level:** Medium (export logic changes)
**Files Involved:** `exporter.ts` (not in pipeline but related)

---

## 11. Export Overhead

### 11.1 Excel Generation Blocking

**Bottleneck:** `exceljs` creates workbook synchronously in main thread
**Root Cause:** No worker thread for Excel generation
**Estimated Impact:** UI freeze during large exports
**Suggested Optimization:** Web Worker or child process for Excel generation
**Risk Level:** Medium
**Files Involved:** `exporter.ts` (export system)

### 11.2 No Incremental Export

**Bottleneck:** Export only available after job completion
**Root Cause:** Design constraint: export requires complete dataset
**Estimated Impact:** Cannot export partial results during long runs
**Suggested Optimization:** Streaming export API with partial results
**Risk Level:** High (architectural change)
**Files Involved:** Export system design

---

## 12. Scraping Throughput Limitations

### 12.1 Google Maps Rate Limiting

**Bottleneck:** Discovery phase limited by Google Maps anti-bot measures
**Root Cause:** Fixed delays, no adaptive rate limiting
**Estimated Impact:** Hard ceiling of ~20-30 leads/minute from Maps
**Suggested Optimization:** Adaptive delay based on CAPTCHA detection
**Risk Level:** High (blocking risk)
**Files Involved:** `discovery.ts` (anti-blocking logic)

### 12.2 Website Response Time Variance

**Bottleneck:** Scraping throughput = slowest website in batch
**Root Cause:** No timeout differentiation based on website complexity
**Estimated Impact:** Simple sites wait for complex CMS sites
**Suggested Optimization:** Dynamic timeouts based on initial response
**Risk Level:** Medium
**Files Involved:** `scraper.ts` (timeout constants)

### 12.3 Memory-Bound Concurrency

**Bottleneck:** Concurrency limited by single process memory
**Root Cause:** No distributed scraping architecture
**Estimated Impact:** Hard limit of ~10-20 concurrent scrapes per process
**Suggested Optimization:** Worker processes with shared job queue
**Risk Level:** High (architectural change)
**Files Involved:** Entire pipeline architecture

---

## Priority Recommendations

### Immediate Fixes (Low Risk, High Impact):

1. **Parallel email/phone extraction** - 20-30% speedup per lead
2. **Remove redundant HTML parsing** - 5-10% CPU reduction
3. **Enable HTTP compression** - 50% bandwidth reduction
4. **Add jitter to retry delays** - prevent retry storms

### Medium-Term Improvements (Medium Risk):

1. **Browser context pool** - better resource utilization
2. **Domain-level robots.txt caching** - 300-1000ms saving per site
3. **Streaming pipeline within batches** - reduce idle time
4. **Circuit breaker for failing domains** - avoid wasted retries

### Architectural Changes (High Risk, Transformative):

1. **Parallel city job execution** - 5-10x throughput for multi-city runs
2. **Worker process architecture** - break memory/concurrency limits
3. **Priority queue for leads** - process high-value leads first
4. **Streaming export API** - real-time results access

---

## Configuration-Specific Findings

Current `.env` settings creating bottlenecks:

- `SCRAPE_CONCURRENCY=3` (too conservative)
- `REQUEST_DELAY_MS=800` (excessive for non-fallback cases)
- `SCRAPE_MAX_RETRIES=0` (good for stability, but no recovery)
- `RESPECT_ROBOTS_TXT=false` (correct for speed)
- `INTER_JOB_DELAY_MS=0` (no protection between cities)

**Note:** Some "bottlenecks" are intentional anti-blocking measures. Optimization must balance speed against blocking risk.

---

## Testing Recommendations

1. **Load testing** with 1000+ leads to identify scaling limits
2. **Memory profiling** during in-depth scraping
3. **Network simulation** with high latency to test timeout logic
4. **Failure injection** to validate retry/circuit breaker behavior

---

_Audit completed by analyzing pipeline architecture, code patterns, and configuration settings. Findings based on static analysis; actual performance may vary with network conditions and target websites._
