/**
 * pipeline/visitedCities.ts
 * Tracks which cities have already been scraped for a given keyword.
 *
 * Pattern mirrors the 15-day rolling dedup window in deduplicator.ts:
 *   - Module-level Map<string, number> (key → visitedAt timestamp)
 *   - Persists across store.reset() calls for the lifetime of the server process
 *   - Lost on server restart (in-memory only — acceptable, same as dedup window)
 *   - TTL: DEDUP_WINDOW_DAYS (default 15 days)
 *
 * Key format: `${keyword.toLowerCase()}:${cityName.toLowerCase()}:${isoCountry.toUpperCase()}`
 * Example:    `lawyer:albuquerque:US`
 *
 * Usage in controller (start.ts):
 *   - Before dispatching a city job: call isCityVisited() — skip if true
 *   - After a city job completes:    call markCityVisited()
 *
 * CONSTRAINTS:
 * - No pipeline.ts changes.
 * - No file persistence.
 * - No new dependencies.
 */

import { logger } from '../logger';

// ─── Config ───────────────────────────────────────────────────────────────────

const VISIT_WINDOW_MS =
  parseInt(process.env.DEDUP_WINDOW_DAYS ?? '15', 10) * 24 * 60 * 60 * 1000;

// ─── Store ────────────────────────────────────────────────────────────────────

/** key → Unix timestamp (ms) when the city was last scraped for this keyword */
const visitedMap = new Map<string, number>();

// ─── Key Builder ──────────────────────────────────────────────────────────────

function buildKey(keyword: string, city: string, isoCountry: string): string {
  return `${keyword.toLowerCase().trim()}:${city.toLowerCase().trim()}:${isoCountry.toUpperCase().trim()}`;
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

/**
 * Purges entries older than VISIT_WINDOW_MS.
 * Called automatically before each check and mark operation.
 */
function cleanup(): void {
  const cutoff = Date.now() - VISIT_WINDOW_MS;
  let removed = 0;
  for (const [key, visitedAt] of visitedMap) {
    if (visitedAt < cutoff) {
      visitedMap.delete(key);
      removed++;
    }
  }
  if (removed > 0) {
    logger.info(
      `VisitedCities: cleanup — removed ${removed} expired entries (window=${VISIT_WINDOW_MS / 86400000}d)`
    );
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns true if this city was already scraped for this keyword
 * within the current visit window (DEDUP_WINDOW_DAYS).
 *
 * Automatically purges stale entries before checking.
 */
export function isCityVisited(keyword: string, city: string, isoCountry: string): boolean {
  cleanup();
  const key = buildKey(keyword, city, isoCountry);
  const visitedAt = visitedMap.get(key);
  if (visitedAt === undefined) return false;
  return Date.now() - visitedAt < VISIT_WINDOW_MS;
}

/**
 * Records that this city was scraped for this keyword right now.
 * Call after a city job completes (regardless of how many leads it yielded).
 */
export function markCityVisited(keyword: string, city: string, isoCountry: string): void {
  const key = buildKey(keyword, city, isoCountry);
  visitedMap.set(key, Date.now());
}

/**
 * Returns the number of currently tracked city visits (within the window).
 * Useful for monitoring and tests.
 */
export function getVisitedCityCount(): number {
  return visitedMap.size;
}

/**
 * Clears all visit records.
 * Intended for use in tests only — do NOT call in production code.
 */
export function clearVisitedCitiesForTesting(): void {
  visitedMap.clear();
}
