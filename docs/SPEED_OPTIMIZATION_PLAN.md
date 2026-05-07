# Speed Optimization Plan

**Date:** May 6, 2026  
**Based on:** SPEED_AUDIT_RAW.md analysis  
**Goal:** 3-5x throughput improvement while maintaining stability and anti-blocking protections

## Executive Summary

This plan implements a phased optimization strategy starting with low-risk, high-impact changes and progressing to architectural improvements. The hybrid discovery strategy (Serper + Maps fallback) is Phase 1, targeting the biggest bottleneck: Google Maps discovery latency.

---

## Phase 1: Hybrid Discovery Strategy (Immediate)

### Goal

Replace slow Google Maps Playwright discovery with fast Serper API as primary source, falling back to existing Maps scraper only when necessary.

### Expected Performance Gain

- **Discovery speed:** 10-30 seconds → 2-5 seconds per city
- **Success rate:** Maintain 95%+ with automatic fallback
- **CAPTCHA risk:** Reduce by 80% (fewer Maps interactions)

### Implementation Tasks

#### 1.1 Environment Configuration

- Add to `backend/.env.example`:
  ```
  SERPER_API_KEY=
  SERPER_ENABLED=true
  SERPER_RESULTS_PER_QUERY=20
  SERPER_TIMEOUT_MS=8000
  ```
- Update `backend/.env` with actual API key (optional for testing)

#### 1.2 Create Serper Integration Module

**File:** `backend/src/pipeline/serper.ts`
**Features:**

- `searchSerper(query: string): Promise<SerperResult[]>`
- Timeout handling (8s default)
- Retry with jitter (max 1 retry)
- Graceful failure → returns empty array
- Normalized output matching `RawLead` shape
- Metrics: `serper_queries`, `serper_failures`, `serper_fallbacks`, `serper_results_used`

**Result Priority:**

1. `localResults` (Google Maps structured data)
2. `places` (Google Places results)
3. `map-pack` style results
4. Organic results (fallback)

**Normalization Rules:**

- `name`: Required, from `title` or `name` field
- `website`: Required for downstream scraping, from `website` or `link` field
- `phone`: Optional bonus, from `phone` field
- `address`: Optional bonus, from `address` or `snippet`
- `email`: NEVER extracted at Serper layer

#### 1.3 Modify Discovery Module

**File:** `backend/src/pipeline/discovery.ts`
**Changes:**

- Add `import { searchSerper } from './serper'`
- Modify `discoverLeads()` function:
  1. Check `SERPER_ENABLED` env var
  2. If enabled, call `searchSerper()` with query format: `"{keyword} {city} {country}"`
  3. Validate results:
     - Minimum results: `Math.min(5, SERPER_RESULTS_PER_QUERY / 4)`
     - Must have website URLs (website-less results are low-value)
  4. If Serper succeeds with sufficient results:
     - Normalize to `RawLead[]`
     - Increment `serper_results_used` metric
     - Return results immediately
  5. If Serper fails (any condition):
     - Increment `serper_fallbacks` metric
     - Fall back to existing Playwright Maps scraper (unchanged logic)
     - Log fallback reason for monitoring

**Fallback Conditions:**

- Serper request fails (network, timeout, API error)
- Quota exhausted (429 response)
- Fewer than minimum results with website URLs
- Zero results returned

#### 1.4 Metrics Integration

**File:** `backend/src/store.ts`
**Add to `FailureMetrics` interface:**

```typescript
serper_queries: number;
serper_failures: number;
serper_fallbacks: number;
serper_results_used: number;
```

**Update `store.reset()`** to initialize these metrics to 0.

### Affected Files

- `backend/src/pipeline/serper.ts` (new)
- `backend/src/pipeline/discovery.ts` (modified)
- `backend/src/store.ts` (modified)
- `backend/src/types.ts` (modified)
- `backend/.env.example` (modified)
- `backend/.env` (optional)

### Risks

- **Low:** Serper API changes or deprecation
- **Medium:** Free tier quota exhaustion in production
- **Low:** Normalization bugs (missing fields)
- **Low:** Fallback logic failures

### Validation Strategy

1. **Unit Tests:** Serper normalization, fallback conditions
2. **Integration Tests:** Full discovery flow with mock Serper responses
3. **Load Testing:** 100+ queries to verify quota handling
4. **A/B Testing:** Compare Serper vs Maps results for same queries
5. **Monitoring:** Track `serper_fallbacks` rate in production

### Free Tier Safety

- Implement exponential backoff on 429 responses
- Automatic fallback to Maps on quota exhaustion
- No crash on API failure (empty array return)
- Configurable timeout (8s default)
- **Serper Concurrency Limiter:** Max 2-5 concurrent Serper requests to prevent quota bursts and fallback storms

### 1.5 Serper Query Cache Dependency

**Purpose:** Prevent quota waste and repeated discovery of same queries
**Cache Key:** `keyword|city|country`
**TTL:** 12-24 hours
**Store:** Normalized results, timestamp, source attribution
**Implementation:** Must exist before later throughput optimizations to establish baseline performance

### 1.6 Source Attribution

**Update Normalization Rules:**

- Add `source: "serper" | "maps"` field to normalized results
- **Purpose:** Quality comparison, fallback analysis, debugging, lead source analytics
- **Implementation:** Track in normalized `RawLead` shape for downstream processing

---

## Observability Foundation (Prerequisite for All Optimization Phases)

### Goal

Establish baseline performance measurements before implementing any optimizations. No optimization phases proceed without these measurements.

### Required Timing Metrics

- **City discovery duration** (total per city)
- **Serper request duration** (API call timing)
- **Maps fallback duration** (when triggered)
- **Scrape duration per lead** (website fetch + extraction)
- **Batch duration** (processing time per batch)
- **Leads/hour** (throughput metric)
- **Fallback rate** (Serper → Maps percentage)

### Implementation

- Add performance timing to `discovery.ts`, `serper.ts`, `pipeline.ts`
- Store in metrics store alongside failure metrics
- Export via `/api/status` endpoint
- Dashboard visualization for monitoring

### Dependency

All Phase 2+ optimizations require baseline measurements from this observability layer.

---

## Feature Flags (Prerequisite for Risky Optimizations)

### Goal

Enable safe rollback and A/B testing for all risky optimizations.

### Required Feature Flags

- `SERPER_ENABLED` (already in Phase 1)
- `DYNAMIC_WAITS_ENABLED` (Phase 3)
- `BROWSER_POOL_ENABLED` (Phase 3.1)
- `ADAPTIVE_CONCURRENCY_ENABLED` (Phase 4.2)
- `HIGHER_CONCURRENCY_ENABLED` (Phase 4.1)

### Implementation

- Runtime-toggleable via environment variables
- Fallback to safe defaults when disabled
- No architectural changes when flags are off
- Monitoring of flag usage and performance impact

### Purpose

Safe rollback capability for all optimization phases.

---

## Phase 2: Low-Risk Pipeline Optimizations (Week 1-2)

### Goal

Implement non-breaking optimizations identified in audit as "Immediate Fixes."

### 2.1 Parallel Email/Phone Extraction

**Files:** `backend/src/pipeline/pipeline.ts`
**Change:** Replace sequential `await extractEmail()` then `extractPhone()` with `Promise.all()`
**Expected Gain:** 20-30% speedup per lead
**Risk:** Low (async behavior unchanged)

### 2.2 Remove Redundant HTML Parsing

**Files:** `emailExtractor.ts`, `phoneNormalizer.ts`, `filter.ts`
**Change:** Pass shared Cheerio `$` object between extractors instead of reloading HTML
**Expected Gain:** 5-10% CPU reduction
**Risk:** Medium (extractors must remain pure/read-only before shared parser usage)
**Requirement:** Audit extractor functions to ensure they don't modify the shared DOM object

### 2.3 Enable HTTP Compression

**Files:** `backend/src/pipeline/antiBlocking.ts`
**Change:** Add `'Accept-Encoding': 'gzip, deflate, br'` to `getExtraHeaders()`
**Expected Gain:** 50% bandwidth reduction
**Risk:** Low (header change only)

### 2.4 Add Jitter to Retry Delays

**Files:** `backend/src/pipeline/scraper.ts`
**Change:** Modify retry delay: `baseDelay * (2^attempt) + randomJitter`
**Expected Gain:** Prevent retry stampedes
**Risk:** Low

---

## Phase 3: Medium-Risk Optimizations (Week 3-4)

### Goal

Improve resource utilization and reduce blocking operations.

### 3.1 Browser Context Pool (After Stability Validation)

**Files:** `backend/src/pipeline/scraper.ts`, `backend/src/pipeline/antiBlocking.ts`
**Change:** Implement pool of 2-3 browser contexts initially for concurrent scraping
**Expected Gain:** Better resource utilization, reduced context switching
**Risk:** Medium (requires audit of existing page pool first, risk of zombie contexts, memory leaks, stealth inconsistency)
**Requirement:** Only implement after production stability metrics exist from Observability Foundation. Increase pool size only after: memory profiling, CAPTCHA monitoring, production stability validation. Long-duration runtime memory monitoring required before increasing browser pool size to detect delayed Playwright memory leaks and zombie contexts.
**Dependency:** Feature flag `BROWSER_POOL_ENABLED`

### 3.2 Domain-Level Robots.txt Caching

**Files:** `backend/src/pipeline/robots.ts`
**Change:** Cache robots.txt responses with 24-hour TTL
**Expected Gain:** 300-1000ms saving per website (when enabled)
**Risk:** Low (caching logic)

### 3.3 Existing Streaming Pipeline Audit

**Purpose:** Audit current pipeline behavior before implementing streaming optimizations
**Files:** `backend/src/pipeline/pipeline.ts`
**Audit Focus:**

- Current batch processing behavior
- SSE emission timing and ordering
- Stop condition handling during partial batch completion
- Deduplication assumptions during streaming
  **Requirement:** Avoid duplicate streaming logic, duplicate emits, broken stop conditions
  **Outcome:** Document current behavior before implementing Phase 3.4 changes

### 3.4 Dynamic Scroll Waiting (Moved from Phase 2.5)

**Files:** `backend/src/pipeline/discovery.ts`
**Change:** Replace `SCROLL_PAUSE_MS=1200` with DOM readiness check
**Expected Gain:** 2-4 seconds saved per city discovery
**Risk:** Medium (Maps DOM changes)
**Requirement:** Only implement after Serper fallback stability validation to avoid silent Maps regressions
**Dependency:** Feature flag `DYNAMIC_WAITS_ENABLED`

### 3.5 Streaming Pipeline Within Batches

**Files:** `backend/src/pipeline/pipeline.ts`
**Change:** Process leads as they complete scraping instead of waiting for full batch
**Expected Gain:** 30-40% reduction in batch idle time
**Risk:** Medium (pipeline flow changes)
**Dependency:** Requires completion of Existing Streaming Pipeline Audit (3.3)

### 3.6 Circuit Breaker for Failing Domains

**Files:** `backend/src/pipeline/scraper.ts`
**Change:** Track failing domains, skip for 5 minutes after 3 failures
**Expected Gain:** Avoid wasted retries on hopeless cases
**Risk:** Low

### 3.7 Async Logging with Buffering

**Files:** `backend/src/logger.ts`
**Change:** Configure Winston for async file writes
**Expected Gain:** Reduce I/O blocking during high-volume logging
**Risk:** Low
**Requirement:** Use small flush intervals to reduce crash-loss risk for fatal errors and final metrics.

---

## Phase 4: Intra-City Concurrency Improvements (Week 5-6)

### Goal

Increase scraping throughput within individual cities.

### 4.1 Increase SCRAPE_CONCURRENCY Cap

**Files:** `backend/src/pipeline/pipeline.ts`
**Change:** Increase max from 6 to 4-6 recommended safe concurrency (configurable up to 8 with monitoring)
**Expected Gain:** 1.3-1.8x realistic throughput improvement before blocking/memory saturation
**Risk:** Medium (higher concurrency increases CAPTCHA/blocking risk globally)
**Dependency:** Feature flag `HIGHER_CONCURRENCY_ENABLED`
**Note:** Conservative increase recommended to balance speed vs. blocking risk. Global scraping stability limits aggressive concurrency scaling.

### 4.2 Adaptive Concurrency

**Files:** `backend/src/pipeline/pipeline.ts`
**Change:** Dynamic concurrency based on success rate and response times
**Expected Gain:** Optimal throughput without triggering blocks
**Risk:** Medium (adaptive algorithm complexity)

### 4.3 Priority Queue for Leads

**Files:** `backend/src/pipeline/pipeline.ts`
**Change:** Process leads with websites first, then those without
**Expected Gain:** Higher-value leads processed earlier
**Risk:** Low

---

## Phase 5: Architectural Improvements (Week 7-8)

### Goal

Break fundamental scalability limits.

### 5.1 Parallel City Job Execution

**Files:** `backend/src/pipeline/pipeline.ts`, controller (`start.ts`)
**Change:** Process multiple cities concurrently with isolated resources
**Expected Gain:** 2-5x realistic throughput scaling before blocking, browser contention, memory saturation, and network bottlenecks
**Risk:** High (requires job coordination, resource partitioning)
**Dependency:** Dedup layer must become concurrency-safe before parallel city execution. Shared dedup state can corrupt data during concurrent city processing.

### 5.2 Worker Process Architecture

**Files:** Entire pipeline architecture
**Change:** Master-worker model with shared job queue
**Expected Gain:** Break single-process memory/concurrency limits
**Risk:** High (distributed system complexity)
**Dependency:** Persistent/shared storage required before worker-process architecture. Required for: dedup consistency, queue coordination, metrics aggregation, progress tracking.

### 5.3 Work Stealing Between Batches

**Files:** `backend/src/pipeline/pipeline.ts`
**Change:** Worker pool model instead of batch `Promise.all()`
**Expected Gain:** Batch time ≠ slowest lead × concurrency
**Risk:** VERY HIGH (modifies execution semantics, affects SSE ordering, affects stop conditions, affects progress tracking, affects dedup assumptions)
**Recommendation:** Implement in late Phase 5 only after production-scale validation of execution semantics.

### 5.4 Streaming Export API

**Files:** `backend/src/exporter.ts`, API routes
**Change:** Real-time export of partial results during long runs
**Expected Gain:** User can access results before job completion
**Risk:** Medium (API design changes)

### 5.5 Memory-Optimized HTML Processing

**Files:** `emailExtractor.ts`, `phoneNormalizer.ts`, `indepth.ts`
**Change:** Stream HTML processing instead of loading full documents
**Expected Gain:** 50-80% memory reduction
**Risk:** High (extraction logic rewrite)

---

## Phase 6: Advanced Optimization (Future)

### Goal

Cutting-edge improvements for maximum performance.

### 6.1 Geographic Proxy Rotation

**Files:** `backend/src/pipeline/antiBlocking.ts`
**Change:** Rotate proxies based on target website location
**Expected Gain:** Reduced latency, lower CAPTCHA rates
**Risk:** High (cost, proxy management)

### 6.2 Predictive Pre-fetching

**Files:** Discovery and scraping pipeline
**Change:** Pre-fetch websites for next batch during current batch processing
**Expected Gain:** Near-zero idle time between batches
**Risk:** High (prediction accuracy)

### 6.3 ML-Based Quality Filtering

**Files:** `backend/src/pipeline/filter.ts`
**Change:** Predict lead quality before full scraping
**Expected Gain:** Skip low-quality leads earlier
**Risk:** High (ML model training)

---

## Implementation Priority Matrix

| Priority | Phase                           | Expected Gain         | Risk   | Effort |
| -------- | ------------------------------- | --------------------- | ------ | ------ |
| P0       | Phase 1 (Hybrid Discovery)      | 5-10x discovery speed | Low    | Low    |
| P1       | Phase 2.1 (Parallel extraction) | 20-30% per lead       | Low    | Low    |
| P1       | Phase 2.2 (Redundant parsing)   | 5-10% CPU             | Medium | Low    |
| P1       | Phase 2.3 (HTTP compression)    | 50% bandwidth         | Low    | Low    |
| P2       | Phase 2.4 (Retry jitter)        | Prevent storms        | Low    | Low    |
| P3       | Phase 3.1 (Browser pool)        | Better utilization    | Medium | Medium |
| P3       | Phase 3.2 (Robots caching)      | 300-1000ms/site       | Low    | Low    |
| P4       | Phase 3.4 (Dynamic scroll)      | 2-4s per city         | Medium | Medium |
| P4       | Phase 3.5 (Streaming batches)   | 30-40% idle reduction | Medium | Medium |
| P4       | Phase 4.1 (Higher concurrency)  | 1.3-1.8x throughput   | Medium | Low    |
| P5       | Phase 5.1 (Parallel cities)     | 5-10x multi-city      | High   | High   |
| P5       | Phase 5.2 (Worker processes)    | Break limits          | High   | High   |

---

## Success Metrics

### Quantitative

- **Discovery time:** < 5 seconds per city (from 10-30s)
- **Leads per hour:** > 200 (from ~50-80)
- **Memory usage:** < 500MB for 1000 leads (from ~1GB)
- **CPU utilization:** > 70% during active scraping (from ~30%)
- **Fallback rate:** < 5% (Serper → Maps)

### Qualitative

- No regression in lead quality
- No increase in CAPTCHA blocks
- Maintain free tier compatibility
- Backward compatibility with existing jobs
- Monitoring dashboard for new metrics

---

## Risk Mitigation

### Technical Risks

1. **Serper API changes:** Regular monitoring, version pinning
2. **Quota exhaustion:** Aggressive fallback, usage alerts
3. **Normalization bugs:** Comprehensive test suite
4. **Resource exhaustion:** Monitoring, circuit breakers
5. **Pipeline regressions:** A/B testing, canary deployments

### Operational Risks

1. **Cost increase:** Serper API costs vs. time savings
2. **Monitoring gap:** New metrics dashboard
3. **Team training:** Documentation for new architecture
4. **Deployment complexity:** Phased rollout plan

---

## Validation Strategy

### Phase 1 Validation

1. **Unit tests:** Serper normalization, fallback logic
2. **Integration tests:** Full discovery flow
3. **Load tests:** Representative production-scale query testing (avoid unrealistic free-tier quota pressure during early validation)
4. **A/B test:** Compare Serper vs Maps for 1000 leads
5. **Production canary:** 10% traffic for 48 hours

### Ongoing Validation

1. **Performance monitoring:** Real-time dashboards
2. **Quality sampling:** Manual review of 5% of leads
3. **Error rate tracking:** Alert on >2% failure rate
4. **Resource monitoring:** CPU, memory, network usage
5. **User feedback:** Export quality surveys

---

## Rollout Plan

### Week 1: Foundation

- Implement Phase 1 (Hybrid Discovery)
- Add monitoring for new metrics
- Deploy to staging, run A/B tests

### Week 2: Low-Risk Optimizations

- Implement Phase 2 items
- Performance benchmarking
- Deploy to production (canary)

### Week 3-4: Medium-Risk Optimizations

- Implement Phase 3 items
- Load testing at scale
- Full production deployment

### Week 5-8: Advanced Optimizations

- Implement Phases 4-5 based on results
- Architectural review at each milestone
- Production rollout with feature flags

---

## Conclusion

This phased optimization plan targets a 3-5x overall throughput improvement while maintaining system stability and lead quality. Phase 1 (Hybrid Discovery) alone should deliver 5-10x faster discovery, addressing the biggest bottleneck identified in the audit.

The plan prioritizes low-risk, high-impact changes first, isolates architectural changes into later phases, and includes comprehensive validation at each step. All optimizations preserve the existing pipeline architecture unless explicitly required for scalability breakthroughs.

**Next Step:** Begin Phase 1 implementation with Serper integration module.
