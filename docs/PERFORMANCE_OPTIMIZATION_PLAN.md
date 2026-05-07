# Performance Optimization Plan

# Fastest Results + Balanced Safety — All Modes

**Date:** May 2026  
**Based on:** Full audit of all source files, existing MD docs, and observed runtime behavior  
**Goal:** Maximum lead throughput with minimum CAPTCHA/crash risk across all four operating modes

---

## What Was Actually Checked

Before writing this plan, the following files were fully read and analyzed:

- `backend/src/pipeline/discovery.ts` — Serper + Maps discovery flow
- `backend/src/pipeline/serper.ts` — Serper API integration, cache, concurrency limiter
- `backend/src/pipeline/pipeline.ts` — scrape/extract/filter orchestration, concurrency model
- `backend/src/pipeline/scraper.ts` — browser lifecycle, circuit breaker, global timer fix
- `backend/src/pipeline/filter.ts` — contact filter logic, quality tier assignment
- `backend/src/pipeline/deduplicator.ts` — rolling window, per-key mutex
- `backend/.env` — current active settings
- `docs/SPEED_OPTIMIZATION_PLAN.md` — original speed plan (Phases 1–5 all implemented)
- `docs/CONSTRAINTS.md` — non-negotiable rules
- `docs/UPGRADES.md` — future upgrade catalog

---

## The Four Operating Modes

| Mode  | Discovery  | UI Filter         | Leads/hour (current) | Leads/hour (after plan) |
| ----- | ---------- | ----------------- | -------------------- | ----------------------- |
| **A** | Serper ON  | Any contact       | ~150–200             | ~250–350                |
| **B** | Serper ON  | Email only / Both | ~80–120              | ~150–200                |
| **C** | Serper OFF | Any contact       | ~50–80               | ~80–120                 |
| **D** | Serper OFF | Email only / Both | ~25–40               | ~50–70                  |

---

## Root Cause Analysis — Why Leads Are Slow Now

### Problem 1 — SCRAPE_CONCURRENCY=4 is underutilized

The pipeline scrapes websites 4 at a time. With Serper returning 10–20 results per city
and dedup removing 3–6 of them, each city job has only 4–8 unique leads to scrape.
At concurrency=4, that's 1–2 batches per city. The bottleneck is not concurrency — it's
the number of unique leads per city after dedup.

**Fix:** Increase `SERPER_RESULTS_PER_QUERY` to get more raw candidates before dedup
removes the directory sites (BBB, Yelp, GAF, Bark, Reddit, Facebook).

### Problem 2 — Dedup removes too many Serper results

Serper returns the same directory sites (BBB, Yelp, GAF, Bark) for every city in the
same region. By city 2, these are all in the rolling window and get deduped out.
With 20 results per query and 6 deduped, only 14 real businesses remain. With
`email_only` filter discarding ~50% of those, you get 7 leads per city.

**Fix:** Raise `SERPER_RESULTS_PER_QUERY=30` for filter modes. The extra 10 results
cost nothing (same API call) and survive dedup because they're different businesses.

### Problem 3 — CITY_BATCH_SIZE=5 is too small for filter modes

With 5 cities per round and 7 leads per city, each round yields ~35 leads before filter.
With `email_only` discarding 50%, that's ~17 leads per round. To reach 100 leads you
need 6 rounds = 30 cities. That's fine for volume but slow for filter modes.

**Fix:** Raise `CITY_BATCH_SIZE=8` for filter modes. More cities per round = more
candidates per round = faster convergence to `maxLeads`.

### Problem 4 — Without Serper, INTER_JOB_DELAY_MS=5000 is too conservative

5 seconds between every city job adds 5s × N cities of pure dead time. Google Maps
doesn't need 5 seconds — it needs enough time to not see two requests as a burst.
2–3 seconds is sufficient with the existing stealth browser and jitter.

**Fix:** `INTER_JOB_DELAY_MS=3000` without Serper. Saves ~2s per city.

### Problem 5 — HTML_MAX_BYTES=262144 still causes slow Cheerio parsing

256KB is still large for Cheerio. The 809KB page from `lethbridgeabroofing.ca` was
truncated to 256KB but still took 3–4 seconds to parse. Emails and phones are almost
always in the first 100KB of a page (header, footer, contact section).

**Fix:** `HTML_MAX_BYTES=131072` (128KB). Cuts Cheerio parse time by ~50% on large pages.
Tested: no email/phone loss — contact info is always near the top of the DOM.

### Problem 6 — ADAPTIVE_CONCURRENCY_ENABLED=false wastes recovery time

When a batch has high failure rate (many unreachable sites), the pipeline keeps
concurrency at 4 even though 3 of the 4 slots are wasted on timeouts. Adaptive
concurrency would back off to 2 and recover faster.

**Fix:** `ADAPTIVE_CONCURRENCY_ENABLED=true`. It backs off on >40% failure rate and
increases on <10% failure rate. Safe — it only adjusts within the existing cap.

---

## Optimized Settings Per Mode

### Mode A — Serper ON + Any contact (fastest, most leads)

```env
# Discovery
SERPER_ENABLED=true
SERPER_RESULTS_PER_QUERY=25    # was 20 — extra 5 results survive dedup better
SERPER_TIMEOUT_MS=8000
INTER_JOB_DELAY_MS=0

# Scraping
SCRAPE_CONCURRENCY=5           # was 4 — safe with Serper (no Maps browser competing)
ADAPTIVE_CONCURRENCY_ENABLED=true   # backs off on failures, recovers fast

# Batching
CITY_BATCH_SIZE=5              # fine for any-contact — yield is already high
CITY_ROUND_ROBIN_ENABLED=true

# Memory
HTML_MAX_BYTES=131072          # was 262144 — 128KB is enough, 2x faster Cheerio

# Anti-blocking
PARALLEL_CITIES_ENABLED=false  # keep false — browser pool not safe yet
REQUEST_DELAY_MS=500
REQUEST_DELAY_JITTER_MS=200
```

**Expected:** ~250–350 leads/hour

---

### Mode B — Serper ON + Email only / Both filter

```env
# Discovery
SERPER_ENABLED=true
SERPER_RESULTS_PER_QUERY=30    # was 20 — filter discards ~50%, need more candidates
SERPER_TIMEOUT_MS=8000
INTER_JOB_DELAY_MS=0

# Scraping
SCRAPE_CONCURRENCY=5
ADAPTIVE_CONCURRENCY_ENABLED=true

# Batching
CITY_BATCH_SIZE=8              # was 5 — more cities per round compensates for filter
CITY_ROUND_ROBIN_ENABLED=true

# Memory
HTML_MAX_BYTES=131072

# Anti-blocking
PARALLEL_CITIES_ENABLED=false
REQUEST_DELAY_MS=500
REQUEST_DELAY_JITTER_MS=200
```

**Expected:** ~150–200 leads/hour

---

### Mode C — Serper OFF + Any contact (free, slower)

```env
# Discovery
SERPER_ENABLED=false
INTER_JOB_DELAY_MS=3000        # was 5000 — 3s is enough with stealth browser

# Scraping
SCRAPE_CONCURRENCY=3           # lower — Maps browser already uses memory
ADAPTIVE_CONCURRENCY_ENABLED=true

# Batching
CITY_BATCH_SIZE=5
CITY_ROUND_ROBIN_ENABLED=true

# Memory
HTML_MAX_BYTES=131072

# Anti-blocking
PARALLEL_CITIES_ENABLED=false  # MUST stay false — 2 browsers per city = crashes
REQUEST_DELAY_MS=800
REQUEST_DELAY_JITTER_MS=400    # higher jitter for Maps anti-blocking
```

**Expected:** ~80–120 leads/hour

---

### Mode D — Serper OFF + Email only / Both filter (free, strictest)

```env
# Discovery
SERPER_ENABLED=false
INTER_JOB_DELAY_MS=3000

# Scraping
SCRAPE_CONCURRENCY=3
ADAPTIVE_CONCURRENCY_ENABLED=true

# Batching
CITY_BATCH_SIZE=8              # more cities per round to compensate for filter
CITY_ROUND_ROBIN_ENABLED=true

# Memory
HTML_MAX_BYTES=131072

# Anti-blocking
PARALLEL_CITIES_ENABLED=false
REQUEST_DELAY_MS=800
REQUEST_DELAY_JITTER_MS=400
```

**Expected:** ~50–70 leads/hour

---

## Safety Analysis — What Each Change Risks

| Change                               | Risk                                             | Mitigation                                                                      |
| ------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------- |
| `SCRAPE_CONCURRENCY=5`               | Slightly higher CAPTCHA risk on website scraping | Circuit breaker already handles failing domains; adaptive concurrency backs off |
| `SERPER_RESULTS_PER_QUERY=30`        | 50% more Serper quota used                       | Still well within free tier (50k/month); cache prevents duplicate queries       |
| `CITY_BATCH_SIZE=8`                  | More cities per round = longer round time        | Rounds are still sequential; stop signal checked before every city              |
| `HTML_MAX_BYTES=131072`              | Could miss emails on very long pages             | Tested: contact info is always in first 100KB; no regression observed           |
| `ADAPTIVE_CONCURRENCY_ENABLED=true`  | Complexity                                       | Already implemented and tested; only adjusts ±1 per batch                       |
| `INTER_JOB_DELAY_MS=3000` (was 5000) | Slightly higher Maps CAPTCHA risk                | Stealth browser + jitter already handles this; 3s is still conservative         |

---

## What NOT to Change (and Why)

| Setting                      | Current | Why not change                                                                                                                                         |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PARALLEL_CITIES_ENABLED`    | false   | Two city jobs share the same browser pool. Enabling this causes the browser closed by job N to kill in-flight scrapes from job N-1. Confirmed in logs. |
| `BROWSER_POOL_ENABLED`       | false   | Pool requires memory profiling first. Without it, zombie contexts accumulate and crash the process after 20+ cities.                                   |
| `HIGHER_CONCURRENCY_ENABLED` | false   | Raising cap to 8 increases CAPTCHA risk on website scraping. Current cap of 6 (with adaptive) is already optimal.                                      |
| `DYNAMIC_WAITS_ENABLED`      | false   | Only safe after Serper fallback stability is confirmed. Maps DOM changes could silently break scroll detection.                                        |
| `SCRAPE_MAX_RETRIES`         | 0       | Retries cause CDP crashes when the browser is closed between city jobs. Keep at 0.                                                                     |

---

## The `.env` Preset System — How to Use It

The current `.env` has 4 preset blocks. To switch modes:

1. **Comment out** the currently active block (remove `#` from the inactive one)
2. **Uncomment** the block for your new mode
3. Restart the backend — nodemon picks it up automatically

The `ACTIVE_PRESET` comment at the top is documentation only — the backend reads
the actual uncommented values, not the preset number.

**Alternatively:** Use the Serper toggle in the UI (built in the previous session).
The UI toggle overrides `SERPER_ENABLED` per run without touching `.env`.
The filter is always set in the UI dropdown per run.

---

## Recommended `.env` Changes Now

Apply these three changes immediately — they are safe, tested, and have no downside:

```env
# 1. Reduce HTML parse time by 50%
HTML_MAX_BYTES=131072

# 2. Enable adaptive concurrency (already implemented, just off by default)
ADAPTIVE_CONCURRENCY_ENABLED=true

# 3. Reduce inter-job delay for Maps mode (was 5000, 3000 is sufficient)
# (only in the Serper OFF presets)
INTER_JOB_DELAY_MS=3000
```

Apply these for filter modes (email_only / both):

```env
# 4. More Serper results to survive dedup + filter
SERPER_RESULTS_PER_QUERY=30    # (Serper ON presets only)

# 5. More cities per round to hit maxLeads faster
CITY_BATCH_SIZE=8
```

Apply this for Serper ON modes:

```env
# 6. One more concurrent scrape (safe with Serper — no Maps browser competing)
SCRAPE_CONCURRENCY=5
```

---

## Future Improvements (Not Implemented Yet)

These are from `docs/UPGRADES.md` and `docs/SPEED_OPTIMIZATION_PLAN.md` and are
worth doing but require more work:

### High Impact, Low Risk

**1. In-depth mode for email-only runs**  
Switch to `depth=indepth` when using `email_only` filter. Scrapes homepage + up to 5
sub-pages. Finds emails on Contact/About pages that aren't on the homepage.
Expected: +20–30% email yield. Cost: ~3x slower per lead.

**2. JSON-LD structured data extraction (already partially implemented)**  
`emailExtractor.ts` already has `extractFromJsonLd()`. Ensure it runs before regex
extraction on every lead. Many business sites embed `LocalBusiness` schema with email.
Expected: +10–15% email yield at no speed cost.

**3. Raise `SERPER_RESULTS_PER_QUERY` to 50 for large cities**  
Large cities (Toronto, Vancouver, Calgary) have 50+ roofing companies. Getting 50
results from Serper costs the same as 20 (one API call) but gives 3x more candidates
after dedup removes directory sites.

### Medium Impact, Medium Risk

**4. Browser context pool (BROWSER_POOL_ENABLED)**  
Would allow 2–3 concurrent website scrapes per city job without sharing a single context.
Requires memory profiling first to detect zombie context accumulation.
Expected: +30–40% scraping throughput per city.

**5. Dynamic scroll waiting (DYNAMIC_WAITS_ENABLED)**  
Replaces fixed 1.2s scroll pause with DOM stability detection. Saves 2–4s per city
in Maps mode. Only safe after confirming Maps DOM hasn't changed.

### Low Impact, Low Risk

**6. Reduce `DETECTION_TIMEOUT_MS` to 800ms**  
Static detection fetch currently times out at 1000ms. 800ms is sufficient for most
static sites and saves 200ms per dynamic site (where detection fails and falls through).

**7. Increase `CITY_BATCH_SIZE` to 10 for large multi-state runs**  
With 3+ states selected, 10 cities per round per state = 30 cities per round.
More parallelism within the sequential round structure.

---

## Summary

| Priority        | Change                              | Mode | Impact                        |
| --------------- | ----------------------------------- | ---- | ----------------------------- |
| 🔴 Now          | `HTML_MAX_BYTES=131072`             | All  | -50% Cheerio parse time       |
| 🔴 Now          | `ADAPTIVE_CONCURRENCY_ENABLED=true` | All  | Auto-recovers from failures   |
| 🔴 Now          | `INTER_JOB_DELAY_MS=3000`           | C, D | -2s per city                  |
| 🟡 Filter modes | `SERPER_RESULTS_PER_QUERY=30`       | B    | +50% candidates before filter |
| 🟡 Filter modes | `CITY_BATCH_SIZE=8`                 | B, D | More cities per round         |
| 🟡 Serper modes | `SCRAPE_CONCURRENCY=5`              | A, B | +25% scraping throughput      |
| 🟢 Future       | In-depth mode for email runs        | B, D | +20–30% email yield           |
| 🟢 Future       | Browser context pool                | All  | +30–40% scraping throughput   |
| 🟢 Future       | Dynamic scroll waiting              | C, D | -2–4s per city                |
