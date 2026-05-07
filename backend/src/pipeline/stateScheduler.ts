/**
 * pipeline/stateScheduler.ts
 * Dynamic Round-Robin City Scheduler — Phase 1: Contract + Skeleton
 *
 * PURPOSE
 * -------
 * Pure scheduling utility for multi-selection city-batched scraping.
 * Produces sequential rounds where each round contains up to `batchSize`
 * valid (unvisited) cities from EACH selected region/state, in the original
 * selection order.
 *
 * DESIGN CONSTRAINTS
 * ------------------
 * - No Express dependency.
 * - No SSE dependency.
 * - No pipeline dependency.
 * - No side effects — deterministic and independently testable.
 * - Does NOT call runPipeline(), emitStatus(), or any store method.
 * - Does NOT mark cities as visited — that remains the controller's job.
 * - Does NOT check stop signals — caller checks before calling nextRound().
 *
 * CONCURRENCY SEMANTICS (locked in Phase 1)
 * ------------------------------------------
 * Rounds are strictly sequential:
 *   Round 1 completes fully → Round 2 starts.
 *
 * PARALLEL_CITIES_ENABLED only controls concurrency INSIDE a round.
 * The scheduler itself is unaware of parallelism — it only produces city lists.
 * The controller (start.ts) decides how to execute the cities in each round.
 *
 * VISITED-CITY SKIPPING (lazy)
 * ----------------------------
 * The scheduler does NOT pre-slice fixed chunks and then remove visited cities.
 * Instead, for each selection it advances a cursor through the ranked city list,
 * collecting cities one by one until `batchSize` valid cities are found OR the
 * list is exhausted.  This guarantees exactly `batchSize` valid cities per
 * selection per round (or fewer if the list runs out).
 *
 * EXHAUSTION
 * ----------
 * A selection is marked exhausted when its cursor reaches the end of its ranked
 * city list.  Exhausted selections are skipped in subsequent rounds.
 * When ALL selections are exhausted, nextRound() returns a round with
 * `allExhausted: true` and an empty cities array.
 *
 * FEATURE FLAG
 * ------------
 * The scheduler is only activated when CITY_ROUND_ROBIN_ENABLED=true.
 * The old flattened-batching path in start.ts remains the default.
 *
 * USAGE SKETCH (controller side — implemented in Phase 4)
 * -------------------------------------------------------
 *   const scheduler = createStateScheduler({
 *     selections: [
 *       { name: 'Gujarat',    rankedCities: getFullRankedCities('IN', 'Gujarat') },
 *       { name: 'Rajasthan',  rankedCities: getFullRankedCities('IN', 'Rajasthan') },
 *     ],
 *     batchSize: 10,
 *     isVisited: (city) => isCityVisited(keyword, city.name, isoCode),
 *   });
 *
 *   while (true) {
 *     if (stopSignal.stopped || store.getLeadCount() >= maxLeads) break;
 *     const round = scheduler.nextRound();
 *     if (round.allExhausted) break;
 *     // execute round.cities (sequentially or in parallel — controller's choice)
 *     // mark each city visited after its job completes
 *   }
 */

import { CityEntry } from '../types';

// ─── Public Interfaces ────────────────────────────────────────────────────────

/**
 * One selection (region / state) managed by the scheduler.
 * Selections are processed in the order they appear in the input array.
 */
export interface SchedulerSelection {
  /** Human-readable name used for logging (e.g. "Gujarat", "Texas"). */
  name: string;
  /**
   * Full ranked city list for this selection, sorted by population descending.
   * Produced by getFullRankedCities() from cityPool.ts.
   * The scheduler never mutates this array.
   */
  rankedCities: CityEntry[];
}

/**
 * Input configuration for createStateScheduler().
 */
export interface SchedulerConfig {
  /**
   * Ordered list of selections to schedule.
   * Processing order follows this array — never reordered alphabetically.
   */
  selections: SchedulerSelection[];

  /**
   * Number of valid (unvisited) cities to collect per selection per round.
   * Defaults to CITY_BATCH_SIZE env var (fallback: 5).
   */
  batchSize: number;

  /**
   * Callback used to check whether a city has already been visited.
   * Called lazily as the scheduler advances each selection's cursor.
   * Must be pure from the scheduler's perspective — no side effects.
   *
   * @param city  The candidate city entry.
   * @returns     true if the city should be skipped (already visited).
   */
  isVisited: (city: CityEntry) => boolean;
}

/**
 * A single city scheduled for execution in a round, annotated with its
 * source selection for logging and progress tracking.
 */
export interface ScheduledCity {
  /** The city entry to process. */
  city: CityEntry;
  /** Name of the selection this city belongs to (e.g. "Gujarat"). */
  selectionName: string;
  /** 0-based index of the selection in the original selections array. */
  selectionIndex: number;
}

/**
 * The result of one scheduler round.
 * Returned by StateScheduler.nextRound().
 */
export interface RoundResult {
  /**
   * Ordered list of cities to process in this round.
   * Cities from selection[0] come first, then selection[1], etc.
   * Empty when allExhausted is true.
   */
  cities: ScheduledCity[];

  /**
   * 1-based round number.
   * Incremented on every call to nextRound(), even if the round is empty.
   */
  roundNumber: number;

  /**
   * Names of selections that became exhausted during this round
   * (i.e. their cursor reached the end of rankedCities while collecting
   * cities for this round).
   */
  newlyExhausted: string[];

  /**
   * Names of all selections that are exhausted as of this round
   * (includes selections exhausted in previous rounds).
   */
  allExhaustedSelections: string[];

  /**
   * True when every selection is exhausted and no more cities can be produced.
   * When true, cities is always [].
   * The controller should stop the batch loop when this is true.
   */
  allExhausted: boolean;
}

/**
 * Snapshot of the scheduler's current state.
 * Useful for SSE progress reporting and logging.
 */
export interface SchedulerSnapshot {
  /** Current round number (0 before the first call to nextRound()). */
  currentRound: number;
  /** Per-selection progress entries. */
  selections: SelectionSnapshot[];
  /** True if all selections are exhausted. */
  allExhausted: boolean;
}

/** Per-selection progress snapshot. */
export interface SelectionSnapshot {
  /** Selection name. */
  name: string;
  /** Total cities available in this selection's ranked list. */
  totalCities: number;
  /** Current cursor position (number of cities examined so far). */
  cursor: number;
  /** Number of valid (non-visited) cities yielded so far across all rounds. */
  citiesYielded: number;
  /** True if the cursor has reached the end of rankedCities. */
  exhausted: boolean;
}

/**
 * The scheduler instance returned by createStateScheduler().
 */
export interface StateScheduler {
  /**
   * Produces the next round of cities.
   *
   * For each non-exhausted selection, advances the cursor through rankedCities
   * until `batchSize` valid (non-visited) cities are collected or the list ends.
   * Cities from all selections are concatenated in selection order.
   *
   * Calling nextRound() after allExhausted is true always returns an empty round
   * with allExhausted: true — it is safe to call but a no-op.
   *
   * @returns RoundResult for this round.
   */
  nextRound(): RoundResult;

  /**
   * Returns a snapshot of the current scheduler state without advancing it.
   * Safe to call at any time.
   */
  snapshot(): SchedulerSnapshot;

  /**
   * Resets the scheduler to its initial state (all cursors to 0, round to 0).
   * Intended for testing only — not used in production.
   */
  reset(): void;
}

// ─── Internal State ───────────────────────────────────────────────────────────

/** Internal per-selection tracking record. */
interface SelectionState {
  name: string;
  rankedCities: CityEntry[];
  cursor: number;
  citiesYielded: number;
  exhausted: boolean;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates a new StateScheduler instance.
 *
 * The scheduler is stateful — each call to nextRound() advances internal cursors.
 * Create a new instance for each job run.
 *
 * @param config  Scheduler configuration (selections, batchSize, isVisited).
 * @returns       A StateScheduler ready to produce rounds.
 */
export function createStateScheduler(config: SchedulerConfig): StateScheduler {
  const { selections, batchSize, isVisited } = config;

  if (batchSize < 1) {
    throw new Error(`StateScheduler: batchSize must be >= 1, got ${batchSize}`);
  }
  if (selections.length === 0) {
    throw new Error('StateScheduler: selections array must not be empty');
  }

  // ── Internal mutable state ────────────────────────────────────────────────

  let currentRound = 0;

  const states: SelectionState[] = selections.map((sel) => ({
    name: sel.name,
    rankedCities: sel.rankedCities,
    cursor: 0,
    citiesYielded: 0,
    exhausted: sel.rankedCities.length === 0,
  }));

  // ── Helpers ───────────────────────────────────────────────────────────────

  function isAllExhausted(): boolean {
    return states.every((s) => s.exhausted);
  }

  /**
   * Collects up to `batchSize` valid cities from a single selection,
   * advancing its cursor lazily and skipping visited cities.
   *
   * @param state  The selection's internal state (mutated in place).
   * @returns      Array of ScheduledCity entries for this selection this round.
   */
  function collectFromSelection(state: SelectionState, selectionIndex: number): ScheduledCity[] {
    if (state.exhausted) return [];

    const collected: ScheduledCity[] = [];

    while (collected.length < batchSize && state.cursor < state.rankedCities.length) {
      const city = state.rankedCities[state.cursor];
      state.cursor++;

      if (isVisited(city)) {
        // Skip — do not count toward batchSize
        continue;
      }

      collected.push({
        city,
        selectionName: state.name,
        selectionIndex,
      });
      state.citiesYielded++;
    }

    // Mark exhausted if cursor reached the end
    if (state.cursor >= state.rankedCities.length) {
      state.exhausted = true;
    }

    return collected;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  function nextRound(): RoundResult {
    currentRound++;

    if (isAllExhausted()) {
      return {
        cities: [],
        roundNumber: currentRound,
        newlyExhausted: [],
        allExhaustedSelections: states.map((s) => s.name),
        allExhausted: true,
      };
    }

    const roundCities: ScheduledCity[] = [];
    const newlyExhausted: string[] = [];

    for (let i = 0; i < states.length; i++) {
      const state = states[i];
      const wasExhausted = state.exhausted;

      const batch = collectFromSelection(state, i);
      roundCities.push(...batch);

      // Detect selections that became exhausted during this round
      if (!wasExhausted && state.exhausted) {
        newlyExhausted.push(state.name);
      }
    }

    const allExhaustedSelections = states.filter((s) => s.exhausted).map((s) => s.name);

    return {
      cities: roundCities,
      roundNumber: currentRound,
      newlyExhausted,
      allExhaustedSelections,
      allExhausted: isAllExhausted(),
    };
  }

  function snapshot(): SchedulerSnapshot {
    return {
      currentRound,
      allExhausted: isAllExhausted(),
      selections: states.map((s) => ({
        name: s.name,
        totalCities: s.rankedCities.length,
        cursor: s.cursor,
        citiesYielded: s.citiesYielded,
        exhausted: s.exhausted,
      })),
    };
  }

  function reset(): void {
    currentRound = 0;
    for (const state of states) {
      state.cursor = 0;
      state.citiesYielded = 0;
      state.exhausted = state.rankedCities.length === 0;
    }
  }

  return { nextRound, snapshot, reset };
}
