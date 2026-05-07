# Phase 12–16 Execution Plan (Finalized)

> **Status:** Implementation-Ready  
> **Last Updated:** May 2026  
> **Scope:** Location Engine · City Batching · Query Execution · Global Dedup · Concurrency · UI Flow

---

## Table of Contents

1. [Overview](#1-overview)
2. [Phase 12 — Location Engine](#2-phase-12--location-engine)
3. [Phase 13 — Keyword Rule (1 Keyword)](#3-phase-13--keyword-rule-1-keyword)
4. [Phase 14 — City Batching & Auto-Expansion](#4-phase-14--city-batching--auto-expansion)
5. [Phase 15 — Global Deduplication (15-Day Rolling Window)](#5-phase-15--global-deduplication-15-day-rolling-window)
6. [Phase 16 — Concurrency & Query Priority](#6-phase-16--concurrency--query-priority)
7. [Execution Flow](#7-execution-flow)
8. [Stop Conditions](#8-stop-conditions)
9. [Edge Case Handling](#9-edge-case-handling)
10. [Expected Output & Metrics](#10-expected-output--metrics)
11. [UI Flow](#11-ui-flow)
12. [Rules & Constraints](#12-rules--constraints)

---

## 1. Overview

This document defines the finalized execution model for Phases 12–16 of the lead scraper pipeline. The model is designed for maximum lead yield with minimal complexity, using a single keyword, hybrid location resolution, and city-batched execution.

### Key Principles

- **1 keyword per run** — no expansion, no matrix explosion
- **Batched city execution** — cities loaded in groups of 5, on demand
- **Single stop condition** — `maxLeads` only
- **15-day rolling dedup** — leads reappear after the window expires
- **Sequential job execution** — predictable, low-footprint scraping

### Architecture Constraint

> Do NOT modify pipeline architecture. Extend existing modules only. Maintain backward compatibility.

---

## 2. Phase 12 — Location Engine

### 2.1 Hybrid Resolution Strategy

The location engine uses a three-layer hybrid approach with a strict priority order:

```
Layer 1: Static Base (PRIMARY)
  └─ Hardcoded city list per state (curated, high-quality)
  └─ Must include top ~10 cities per state minimum
  └─ First source consulted — always

Layer 2: Cache (SECONDARY)
  └─ In-memory + persistent cache for previously fetched Nominatim results
  └─ TTL: 7 days
  └─ Consulted when static base is insufficient

Layer 3: Nominatim (FALLBACK ONLY)
  └─ On-demand geocoding — used only when static + cache are insufficient
  └─ Filtered by: place type = city | town, importance threshold
  └─ Results written to cache after fetch
```

**Resolution order:** Static base → Cache → Nominatim (fallback only)

> **Rule:** Nominatim is only invoked when the static base and cache together cannot supply enough cities for the requested pool size. Static base must always include the top ~10 cities per state to minimize Nominatim dependency.

### 2.2 "Major Cities" Filtering

When fetching from Nominatim, apply the following filters:

| Filter        | Value                                |
| ------------- | ------------------------------------ |
| `place` type  | `city` or `town` only                |
| `importance`  | `>= 0.4` (Nominatim score)           |
| `addresstype` | must include `city` or `town`        |
| Exclude       | villages, hamlets, suburbs, counties |

This ensures only population-significant locations are included.

### 2.3 Internal City Pool

Each state maintains an internal city pool of **10–30 cities**, ordered by population descending.

```
State: Texas
Pool (example, 20 cities):
  1. Houston
  2. San Antonio
  3. Dallas
  4. Austin
  5. Fort Worth
  6. El Paso
  7. Arlington
  8. Corpus Christi
  9. Plano
  10. Lubbock
  ... (up to 30)
```

- Pool is built once per state at session start (static + dynamic merged)
- Cities are sorted: largest first (highest lead density priority)
- Pool is NOT fully loaded into the job queue upfront — batched on demand

### 2.4 Location Module Interface (Extension Points)

Extend existing `discovery.ts` — do not replace:

```typescript
// Extend, do not replace
interface CityPool {
  state: string;
  cities: CityEntry[]; // sorted by population desc
  fetchedAt: number; // timestamp
}

interface CityEntry {
  name: string;
  state: string;
  lat?: number;
  lon?: number;
  importance?: number; // Nominatim score
  source: "static" | "nominatim";
}
```

---

## 3. Phase 13 — Keyword Rule (1 Keyword)

### 3.1 Rule

> **Maximum keywords per run: 1**

- The profession dropdown outputs exactly **1 primary keyword**
- No keyword expansion logic
- No synonym generation
- No keyword matrix

### 3.2 Keyword Selection

The user selects a profession from the dropdown. The system maps it to a single search keyword:

```
Profession (UI)       →  Primary Keyword (query)
─────────────────────────────────────────────────
Plumber               →  "plumber"
Electrician           →  "electrician"
HVAC Technician       →  "HVAC"
Dentist               →  "dentist"
Real Estate Agent     →  "real estate agent"
Lawyer                →  "lawyer"
```

### 3.3 Query Construction

Each job query is constructed as:

```
"{keyword}" + "{city}, {state}"

Example:
  keyword = "plumber"
  city    = "Houston"
  state   = "TX"
  query   = "plumber Houston TX"
```

No additional keyword variants are appended. One query per city.

### 3.4 Removed Logic

The following are explicitly removed from Phase 13:

- ~~Keyword expansion (synonyms, variants)~~
- ~~Multi-keyword input field~~
- ~~Keyword matrix (N keywords × M cities)~~
- ~~`maxKeywords` config parameter~~

---

## 4. Phase 14 — City Batching & Auto-Expansion

### 4.1 Batch Size

```
BATCH_SIZE = 5 cities
```

Cities are loaded from the pool in batches of 5. The next batch is only loaded when the current batch is exhausted and `maxLeads` has not been reached.

### 4.2 Batching Logic

```
cityPool = [city1, city2, ..., cityN]   // sorted, 10–30 cities
batchPointer = 0

LOOP:
  batch = cityPool[batchPointer : batchPointer + BATCH_SIZE]
  if batch is empty → STOP (all cities exhausted)

  for each city in batch:
    job = buildJob(keyword, city)
    result = runJob(job)
    totalLeads += result.newLeads

    if totalLeads >= maxLeads → STOP

  batchPointer += BATCH_SIZE
  → load next batch
```

### 4.3 Do NOT Preload

> Cities are loaded on demand. Do NOT enqueue all cities at session start.

This keeps memory footprint low and allows early termination without wasted work.

### 4.4 Batch Execution Example

```
maxLeads = 50
keyword  = "plumber"
state    = "Texas"
cityPool = [Houston, San Antonio, Dallas, Austin, Fort Worth,
            El Paso, Arlington, Corpus Christi, Plano, Lubbock]

Batch 1: Houston, San Antonio, Dallas, Austin, Fort Worth
  → yields 38 leads (totalLeads = 38)
  → 38 < 50 → load next batch

Batch 2: El Paso, Arlington, Corpus Christi, Plano, Lubbock
  → El Paso yields 14 leads (totalLeads = 52)
  → 52 >= 50 → STOP
```

### 4.5 Multi-State Expansion

If the user selects multiple states, city pools are concatenated and batched in order:

```
states = [Texas, Florida]
pool   = [TX cities (sorted)] + [FL cities (sorted)]
batching continues across state boundary seamlessly
```

---

## 5. Phase 15 — Global Deduplication (15-Day Rolling Window)

### 5.1 Window Definition

```
DEDUP_WINDOW_DAYS = 15
```

A lead is considered a duplicate if its unique key was seen within the last 15 days.

### 5.2 Storage Schema

Each dedup entry stores a timestamp. The dedup key is a composite of **phone and root domain**:

```typescript
// Dedup key format: "phone|rootDomain"
// Example: "+15551234567|example.com"
// Both values are normalized before key construction

interface DedupEntry {
  key: string; // composite key: phone|rootDomain
  seenAt: number; // Unix timestamp (ms)
}

// Storage: Map<string, number>  (key → seenAt)
```

**Key construction:**

```typescript
function buildDedupKey(phone: string, rootDomain: string): string {
  return `${normalizePhone(phone)}|${normalizeRootDomain(rootDomain)}`;
}
// Example: "+15551234567|example.com"
```

### 5.3 Cleanup on Load

On every session start and before each run, purge stale entries:

```typescript
function cleanupDedup(store: Map<string, number>): void {
  const cutoff = Date.now() - 15 * 24 * 60 * 60 * 1000;
  for (const [key, seenAt] of store) {
    if (seenAt < cutoff) store.delete(key);
  }
}
```

### 5.4 Dedup Check

```typescript
function isDuplicate(key: string, store: Map<string, number>): boolean {
  const seenAt = store.get(key);
  if (!seenAt) return false;
  const age = Date.now() - seenAt;
  return age < 15 * 24 * 60 * 60 * 1000;
}
```

### 5.5 Incremental Runs Behavior

| Run              | Behavior                                                |
| ---------------- | ------------------------------------------------------- |
| Run 1            | All leads are new. Full yield expected.                 |
| Run 2 (same day) | Most leads are duplicates. Yield significantly reduced. |
| Run 2 (day 8)    | ~50% of leads may reappear (older entries expired).     |
| Run 2 (day 16+)  | All leads reappear. Full yield again.                   |

> **Note:** Leads reappear after 15 days. This is by design — the window prevents same-day spam while allowing periodic re-scraping.

### 5.6 Diminishing Returns Across Runs

```
Run 1:  100% yield  (all new)
Run 2:  20–40%      (most duped, same cities)
Run 3+: 5–15%       (heavily duped until window expires)
Day 16: Reset → back to ~100%
```

### 5.7 Extend Existing Deduplicator

Extend `deduplicator.ts` — add timestamp tracking to existing key store. Do not replace the dedup logic, only add the rolling window layer on top.

---

## 6. Phase 16 — Concurrency & Query Priority

### 6.1 Scrape Concurrency

```
RECOMMENDED: 2–4 concurrent scrapers
MAXIMUM:     5–6 concurrent scrapers
```

Higher concurrency increases block risk. Stay at 2–4 for stable operation.

### 6.2 Job Execution Model

Jobs (city queries) execute **sequentially**. Concurrency applies within a single scrape job (e.g., parallel page fetches), not across jobs.

```
Job Queue:
  [Houston] → run → complete → [San Antonio] → run → complete → ...
  (sequential, one job at a time)

Within each job:
  page 1, page 2, page 3 → fetched with concurrency 2–4
```

### 6.3 Inter-Job Delay (Optional)

Add an optional delay between jobs to reduce detection risk:

```
INTER_JOB_DELAY = 20–30 seconds (recommended)
```

Configurable via `.env`:

```
INTER_JOB_DELAY_MS=25000
```

If not set, defaults to 0 (no delay). Recommended to enable in production.

### 6.4 Query Priority Order

Jobs are ordered to maximize early lead yield:

```
Priority 1: primary keyword + largest cities first
Priority 2: primary keyword + medium cities
Priority 3: primary keyword + smaller cities

Example (Texas, keyword="plumber"):
  1. plumber Houston TX
  2. plumber San Antonio TX
  3. plumber Dallas TX
  4. plumber Austin TX
  5. plumber Fort Worth TX
  ...
```

This ensures the highest-density cities are scraped first, allowing early `maxLeads` termination before smaller cities are reached.

---

## 7. Execution Flow

### 7.1 Full Flow Diagram

```
User Input
  │
  ├─ Profession → 1 keyword (e.g., "plumber")
  ├─ State(s)   → city pool built (10–30 cities/state, sorted)
  └─ maxLeads   → stop target

          │
          ▼
    Build City Pool
    (static base → cache → Nominatim fallback, sorted by population)

          │
          ▼
    Load Batch 1 (5 cities)  ← Job Queue / Controller
          │
          ▼
    ┌──────────────────────────────────────────┐
    │  Job Queue / Controller:                 │
    │    for each city in batch:               │
    │      dispatch single job to pipeline.ts  │
    │      pipeline.ts executes job only       │
    │      collect result                      │
    │      dedup results (phone|rootDomain)    │
    │      totalLeads += new leads             │
    │      if totalLeads >= maxLeads → STOP    │
    └──────────────────────────────────────────┘
          │
          ▼ (batch done, max not reached)
    Job Queue / Controller loads next batch (5 cities)
          │
          ▼
    (repeat until maxLeads OR all cities exhausted)
          │
          ▼
    STOP → Export Results
```

> **Architecture note:** `pipeline.ts` executes a single job only. All batching, city iteration, and stop condition checks are owned by the job queue / controller layer. `pipeline.ts` must not control flow.

### 7.2 Replaced Logic

| Old Model                                 | New Model                  |
| ----------------------------------------- | -------------------------- |
| 5 keywords × 5 cities = 25 jobs           | 1 keyword × batched cities |
| All jobs enqueued upfront                 | Batches loaded on demand   |
| Stop on maxTime OR maxQueries OR maxLeads | Stop on maxLeads only      |
| Keyword expansion in Phase 13             | No expansion — 1 keyword   |

---

## 8. Stop Conditions

### 8.1 Single Stop Condition

```
STOP WHEN: totalLeads >= maxLeads
```

All other stop conditions are removed:

- ~~`maxTime`~~ — removed
- ~~`maxQueries`~~ — removed
- ~~`maxKeywords`~~ — removed

### 8.2 Queue Logic

After each job completes, the **job queue / controller** (not `pipeline.ts`) checks the stop condition:

```typescript
// Job queue / controller — owns stop condition
if (totalLeads >= maxLeads) {
  stopQueue();
  return;
}
// else: continue to next city / next batch
```

> `pipeline.ts` executes a single job and returns results. It does not check `maxLeads`, does not iterate cities, and does not load batches.

### 8.3 Natural Exhaustion

If all cities in all selected states are exhausted before `maxLeads` is reached:

```
→ STOP gracefully
→ status: "partial_success"
→ return all leads collected so far
```

---

## 9. Edge Case Handling

### 9.1 Target Not Reached After All Cities

**Condition:** All cities exhausted, `totalLeads < maxLeads`

**Behavior:**

```
→ Stop gracefully (do not error)
→ Set status: "partial_success"
→ Return all leads collected
→ Log: "City pool exhausted. Collected {n}/{maxLeads} leads."
```

**User Suggestions (surface in UI):**

1. Add more states to expand the city pool
2. Change the keyword to a broader profession
3. Reduce the `maxLeads` target to match available supply

### 9.2 Empty Batch

**Condition:** A batch returns 0 results from scraper

**Behavior:**

```
→ Log warning: "Batch returned 0 results for cities: [...]"
→ Continue to next batch (do not stop)
→ Only stop if all batches exhausted
```

### 9.3 All Results Deduped

**Condition:** Scraper returns results but all are duplicates

**Behavior:**

```
→ totalLeads does not increase
→ Continue to next city/batch
→ If all cities exhausted with 0 new leads → partial_success
→ Suggest: wait 15 days for dedup window to reset
```

### 9.4 Nominatim Unavailable

**Condition:** Nominatim fallback fetch fails (network error, rate limit)

**Behavior:**

```
→ Use static base + cache only (Nominatim is fallback — not required)
→ Log warning: "Nominatim unavailable, using static + cached cities only"
→ Do not abort run
→ Static base top ~10 cities per state ensure minimum viable pool
```

### 9.5 Single City Returns Massive Yield

**Condition:** First city alone exceeds `maxLeads`

**Behavior:**

```
→ Stop after that city's job completes
→ Do not load next batch
→ status: "success"
```

---

## 10. Expected Output & Metrics

### 10.1 Per-Run Estimates

Based on: **1 keyword × batched cities (10–30 per state)**

| Scenario                  | Cities Scraped | Est. Leads/City | Est. Total |
| ------------------------- | -------------- | --------------- | ---------- |
| Small run (maxLeads=25)   | 3–5            | 5–10            | 25         |
| Medium run (maxLeads=100) | 10–15          | 7–12            | 100        |
| Large run (maxLeads=500)  | 20–30          | 15–25           | 500        |
| All cities, no limit      | 10–30          | 10–20           | 100–600    |

_Estimates vary by profession density and city size._

### 10.2 Multi-Run Diminishing Returns

```
Run 1 (Day 1):   Full yield — all leads new
Run 2 (Day 1):   ~20–30% yield — most leads deduped
Run 3 (Day 1):   ~5–10% yield — heavily deduped
...
Day 16+:         Full yield reset — 15-day window expired
```

### 10.3 15-Day Reset Behavior

| Day           | Expected Yield vs Run 1       |
| ------------- | ----------------------------- |
| Day 1 (Run 1) | 100%                          |
| Day 1 (Run 2) | 20–30%                        |
| Day 8         | 40–60% (partial reset)        |
| Day 15        | 80–90% (most entries expired) |
| Day 16+       | ~100% (full reset)            |

### 10.4 Throughput

```
Concurrency: 2–4 scrapers
Inter-job delay: 20–30s
Avg time per city job: 30–90s
Batch of 5 cities: ~3–8 minutes
Full run (20 cities): ~12–30 minutes
```

---

## 11. UI Flow

### 11.1 Input Panel

```
┌─────────────────────────────────────────┐
│  Profession:  [Plumber ▼]               │  ← dropdown → 1 keyword
│  State(s):    [Texas ▼] [+ Add State]   │  ← 1 or more states
│  Max Leads:   [100      ]               │  ← stop target
│                                         │
│  [Start Scraping]                       │
└─────────────────────────────────────────┘
```

**Removed from UI:**

- ~~Multi-keyword input field~~
- ~~Keyword count selector~~
- ~~maxTime / maxQueries fields~~

### 11.2 Status Display

```
Status: Running
Keyword: plumber
Cities processed: 7 / ~20
Leads found: 63 / 100
Current city: Dallas, TX
Batch: 2 of 4
```

### 11.3 Auto-Expansion Note

Surface this note in the UI (tooltip or info text):

> "The system automatically selects and expands cities within your chosen state(s). You don't need to enter cities manually."

### 11.4 Completion States

| Status            | Message                                        |
| ----------------- | ---------------------------------------------- |
| `success`         | "Found {n} leads. Target reached."             |
| `partial_success` | "Found {n}/{max} leads. All cities exhausted." |
| `error`           | "Scraping failed: {reason}"                    |

### 11.5 Partial Success Suggestions (UI)

When `partial_success`:

```
ℹ️  Tip: To find more leads, try:
  • Adding more states (e.g., Florida, California)
  • Changing the profession keyword
  • Lowering your target to {n}
```

---

## 12. Rules & Constraints

### 12.1 Architecture Rules

| Rule                     | Detail                                                         |
| ------------------------ | -------------------------------------------------------------- |
| No pipeline modification | Extend existing modules only                                   |
| Backward compatible      | All existing config keys remain valid                          |
| No new dependencies      | Use existing scraper, dedup, filter modules                    |
| Extend, don't replace    | `deduplicator.ts`, `discovery.ts`, `pipeline.ts` — extend only |

### 12.2 Configuration Reference

```env
# Stop condition
MAX_LEADS=100                  # only stop condition

# City batching
CITY_BATCH_SIZE=5              # cities per batch (default: 5)
CITIES_PER_STATE=20            # pool size per state (default: 10–30)

# Concurrency
SCRAPE_CONCURRENCY=3           # recommended: 2–4, max: 5–6
INTER_JOB_DELAY_MS=25000       # optional inter-job delay (ms)

# Dedup
DEDUP_WINDOW_DAYS=15           # rolling window (default: 15)

# Location
NOMINATIM_IMPORTANCE_MIN=0.4   # min importance score for city inclusion
NOMINATIM_CACHE_TTL_DAYS=7     # cache TTL for Nominatim results
```

### 12.3 Removed Config Keys

The following are no longer used and should be ignored if present:

- ~~`MAX_TIME`~~
- ~~`MAX_QUERIES`~~
- ~~`MAX_KEYWORDS`~~
- ~~`KEYWORD_EXPANSION`~~

### 12.4 Module Extension Map

| Module            | Change Type | Description                                                                         |
| ----------------- | ----------- | ----------------------------------------------------------------------------------- |
| `discovery.ts`    | Extend      | Add hybrid city pool builder (static primary → cache → Nominatim fallback)          |
| `deduplicator.ts` | Extend      | Add `phone\|rootDomain` key, timestamp per key, rolling window cleanup              |
| `pipeline.ts`     | No change   | Executes single job only — must not handle batching, city iteration, or stop checks |
| `filter.ts`       | No change   | Existing filters remain                                                             |
| `scraper.ts`      | No change   | Existing scraper remains                                                            |
| `antiBlocking.ts` | No change   | Existing anti-blocking remains                                                      |

**Job Queue / Controller** (new or extended orchestration layer — not `pipeline.ts`):

| Responsibility       | Owner                  |
| -------------------- | ---------------------- |
| City batch loading   | Job queue / controller |
| City pool iteration  | Job queue / controller |
| Stop condition check | Job queue / controller |
| Single job execution | `pipeline.ts`          |

---

_End of Phase 12–16 Execution Plan_
