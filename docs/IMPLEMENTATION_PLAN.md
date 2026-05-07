# Dynamic Round-Robin Scheduler — Implementation Plan

## Goal

Implement a dynamic round-robin city scheduler for multi-selection scraping that:

* Works for any number of selected regions or states.
* Processes the next 10 valid and unvisited cities from each selection per round.
* Preserves existing scraper pipeline behavior.
* Preserves deduplication, visited-city logic, exports, SSE streaming, and stop handling.
* Remains rollback-safe behind a feature flag.
* Minimizes changes to the current architecture.

This plan is designed around the current project structure:

* `backend/src/routes/start.ts` owns orchestration, batching, stop logic, SSE dispatch, and concurrency.
* `backend/src/pipeline/cityPool.ts` owns ranked city generation.
* `runPipeline()` should remain untouched.
* Existing export, store, dedup, and scraper systems should remain untouched unless absolutely necessary.

---

## Current Problem

The current batching logic in `start.ts`:

1. Flattens all cities from all selections into one array.
2. Processes them sequentially in fixed slices.
3. Applies visited-city filtering after selection logic is already decided.

This causes problems:

* One selection can dominate processing.
* Selection balancing does not exist.
* Visited-city skipping breaks predictable batching.
* Parallel mode can break ordering semantics if rounds are not isolated.
* Batching logic is tightly coupled to the Express controller.

---

## Target Behavior

The scheduler must work dynamically for any number of selected regions or states.

For every round:

* Fetch the next 10 valid cities from each selected region or state.
* Process all selected regions or states in their original selection order.
* Continue round by round until:

  * `maxLeads` is reached,
  * a stop signal is triggered, or
  * all queues are exhausted.

---

## Core Rules

### Rule 1 — Selection Order

Processing order must follow the order chosen in the frontend.

Do not reorder selections alphabetically.

### Rule 2 — City Ranking

City ranking must continue using `getFullRankedCities()` from `backend/src/pipeline/cityPool.ts`.

Ranking behavior must remain unchanged.

### Rule 3 — Lazy Visited-City Skipping

The scheduler must not pre-slice fixed chunks before visited filtering.

Incorrect:

```text
Cities 1-10, then remove visited
```

Correct:

```text
Fetch next 10 valid cities dynamically
```

The scheduler must lazily iterate deeper into each ranked city list until:

* 10 valid cities are collected, or
* the queue is exhausted.

### Rule 4 — Sequential Rounds

Rounds must be sequential.

Round 2 must never begin before all Round 1 jobs complete.

### Rule 5 — Parallelism Scope

`PARALLEL_CITIES_ENABLED` only controls concurrency inside the current round.

It must not allow cross-round overlap.

Correct:

```text
ROUND 1
  Parallel jobs inside Round 1
WAIT
ROUND 2
```

Incorrect:

```text
Round 2 starts before Round 1 completes
```

### Rule 6 — Stop Conditions

Stop immediately when:

* `maxLeads` is reached
* a stop signal is triggered
* all queues are exhausted

No further rounds should start.

### Rule 7 — No Pipeline Changes

Do not modify:

* `runPipeline()`
* scraper internals
* deduplicator internals
* export system
* visitedCities storage
* store architecture

Only orchestration and scheduling changes are intended.

---

## Architecture Changes

### New File

Create:

```text
backend/src/pipeline/stateScheduler.ts
```

Purpose:

* pure scheduling and orchestration utility
* no Express dependency
* no SSE dependency
* no pipeline dependency

This file should be fully unit-testable.

### Scheduler Responsibilities

The scheduler should:

* maintain per-selection queues
* maintain per-selection cursors
* lazily skip visited cities
* generate sequential rounds
* track exhausted selections
* expose round metadata

The scheduler should not:

* emit SSE
* run scraping
* manage store state
* manage Express responses
* directly call `runPipeline()`

---

## Suggested Scheduler Contract

### Input

* ordered selections array
* ranked city arrays per selection
* batch size
* visited-city checker callback
* stop checker callback

### Output

Each call should return:

* next round cities
* exhausted selections
* round number
* completion state

---

## Suggested Internal Model

Each selection should maintain:

```ts
{
  selectionName,
  rankedCities,
  cursor,
  exhausted
}
```

Cursor moves dynamically.

Visited cities are skipped lazily.

---

## Feature Flag

Add early:

```env
CITY_ROUND_ROBIN_ENABLED=false
```

Behavior:

* `false` → existing flattened batching
* `true` → new scheduler path

The old path must remain intact until rollout completes.

---

## Phase Plan

### Phase 1 — Extract Scheduler + Lock Contract

Objectives:

* Create `stateScheduler.ts`
* Define scheduler interfaces
* Define round semantics
* Define concurrency semantics
* Create controller integration sketch

Important:

* No behavior changes yet
* No SSE changes
* No frontend changes

Lock these up front:

* scheduler input shape
* scheduler output shape
* how `start.ts` asks for the next round
* how visited-city checking is passed in
* how exhaustion is reported
* how a round is marked complete
* round concurrency rule: rounds are sequential and concurrency is only inside a round

### Phase 2 — Add Feature Flag

Add:

```env
CITY_ROUND_ROBIN_ENABLED=false
```

Update `backend/src/routes/start.ts` to support:

* old batching path
* new scheduler path

The old path remains default.

### Phase 3 — Build and Test Scheduler

Implement scheduler logic and test it independently.

Test cases:

* one selection
* many selections
* uneven selection sizes
* visited-heavy skipping
* fully exhausted selections
* partially exhausted selections
* sequential rounds
* stable ordering
* stop-safe iteration

Important:

Tests should target only the pure scheduler.

Do not involve:

* Express
* SSE
* scraping
* pipeline

### Phase 4 — Integrate into Controller

Integrate scheduler into `backend/src/routes/start.ts`.

Replace only:

* city-selection logic
* batching orchestration logic

Keep untouched:

* `runPipeline()`
* SSE schema
* deduplication
* exports
* store logic
* scraper flow

Scheduler metadata should remain internal only during this phase.

Do not emit new SSE fields yet.

### Phase 5 — Concurrency Verification

Verify concurrency semantics.

Required guarantees:

* Round 2 never starts before all Round 1 jobs complete.
* `PARALLEL_CITIES_ENABLED` only affects concurrency inside the current round.
* No cross-round leakage.
* `maxLeads` and stop handling still halt immediately.

### Phase 6 — Atomic SSE + Frontend Update

Update backend SSE payloads and frontend rendering together.

Backend files likely affected:

* `backend/src/routes/start.ts`
* `backend/src/sse.ts`
* `backend/src/types.ts` if needed

Frontend files likely affected:

* `frontend/src/hooks/useSSE.ts`
* `frontend/src/components/StatusBar.tsx`
* `frontend/src/app/page.tsx`

New progress data may include:

* current round
* active selections
* per-selection progress
* remaining cities
* exhausted selections

This must be one atomic deployment.

### Phase 7 — Full Regression Testing

Test both paths:

* old flattened batching
* new round-robin batching

Verify:

* feature flag switching
* stop mid-round
* `maxLeads` mid-round
* visited-heavy queues
* exhausted selections
* many-selection runs
* sequential mode
* parallel mode
* SSE stability
* no deadlocks
* no ordering corruption

### Phase 8 — Controlled Rollout

Enable:

```env
CITY_ROUND_ROBIN_ENABLED=true
```

Verify production stability:

* lead counts
* scheduler fairness
* SSE stability
* export stability
* stop handling
* concurrency safety
* no memory leaks

After verification:

* promote as default scheduler
* optionally remove old batching path later

---

## Files Expected To Change

### Backend

```text
backend/src/routes/start.ts
backend/src/pipeline/stateScheduler.ts
backend/src/sse.ts
backend/src/types.ts (only if needed)
```

### Frontend

```text
frontend/src/hooks/useSSE.ts
frontend/src/components/StatusBar.tsx
frontend/src/app/page.tsx
```

---

## Files That Should Not Change

```text
backend/src/pipeline/pipeline.ts
backend/src/pipeline/deduplicator.ts
backend/src/pipeline/scraper.ts
backend/src/exporter.ts
backend/src/store.ts
```

Unless absolutely necessary.

---

## Key Safety Principles

### Keep Scheduler Pure

The scheduler should remain:

* deterministic
* side-effect free
* independently testable

### Keep SSE Atomic

All SSE protocol changes must ship together.

### Keep Rollback Simple

Feature flag must always allow:

```text
new scheduler OFF
old scheduler ON
```

without code rollback.

### Minimize Surface Area

Only change orchestration.

Avoid touching:

* scraping
* extraction
* export
* storage
* dedup internals

This minimizes regression risk.
