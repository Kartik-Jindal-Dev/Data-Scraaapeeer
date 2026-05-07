/**
 * pipeline/deduplicator.ts
 * Deduplication for raw leads.
 *
 * Two-layer dedup:
 *
 * Layer 1 — Per-run Set (existing behaviour, unchanged):
 *   - Owned by store.isDuplicate() via store's dedupSet.
 *   - Cleared on store.reset() at the start of every new job.
 *   - Catches duplicates within a single scrape session.
 *
 * Layer 2 — 15-day rolling window (Phase 15, new):
 *   - Module-level Map<string, number> (key → seenAt timestamp).
 *   - Persists across store.reset() calls for the lifetime of the server process.
 *   - Entries older than DEDUP_WINDOW_DAYS are purged on every cleanup pass.
 *   - Cleanup runs: on module load, and before each isDuplicateLead() call.
 *   - A lead seen in the rolling window is treated as a duplicate even if the
 *     per-run Set was just cleared (i.e. across multiple job runs).
 *   - Leads reappear after DEDUP_WINDOW_DAYS days — by design.
 *
 * Phase 5.1 — Concurrency-safe dedup:
 *   - isDuplicateLead() is now protected by a per-key mutex to prevent
 *     race conditions when multiple city jobs run concurrently.
 *   - The check-then-add sequence is atomic per key.
 *
 * Dedup key format: `${normalizedPhone}|${rootDomain}`
 *   - rootDomain extracted via tldts (handles subdomains + multi-part TLDs).
 *   - If both phone and rootDomain are empty → no key → passes through.
 *
 * CONSTRAINTS:
 * - Do NOT modify store.ts dedup logic — Layer 1 is unchanged.
 * - Rolling window is in-memory only — lost on server restart (acceptable).
 * - No new external dependencies.
 * - Existing tests must continue to pass.
 */

import { parse as parseTld } from 'tldts';
import { logger } from '../logger';
import { store } from '../store';
import { RawLead } from '../types';

// ─── Config ───────────────────────────────────────────────────────────────────

const DEDUP_WINDOW_MS =
  parseInt(process.env.DEDUP_WINDOW_DAYS ?? '15', 10) * 24 * 60 * 60 * 1000;

// ─── Rolling Window Store ─────────────────────────────────────────────────────

/**
 * Persistent cross-run dedup map.
 * Key:   `${phone}|${rootDomain}`
 * Value: Unix timestamp (ms) when the key was first seen.
 *
 * Lives at module scope — survives store.reset() calls.
 * Lost on server restart (in-memory only).
 */
const rollingWindow = new Map<string, number>();

/**
 * Purges entries older than DEDUP_WINDOW_MS from the rolling window.
 * Called on module load and before each dedup check.
 */
function cleanupRollingWindow(): void {
  const cutoff = Date.now() - DEDUP_WINDOW_MS;
  let removed = 0;
  for (const [key, seenAt] of rollingWindow) {
    if (seenAt < cutoff) {
      rollingWindow.delete(key);
      removed++;
    }
  }
  if (removed > 0) {
    logger.info(`Dedup: rolling window cleanup — removed ${removed} expired entries (window=${DEDUP_WINDOW_MS / 86400000}d)`);
  }
}

// Run cleanup once on module load to purge any stale entries from a previous
// server session (if the map were ever persisted — currently it isn't, but
// this is a safe no-op when the map is empty).
cleanupRollingWindow();

// ─── Root Domain Extraction ───────────────────────────────────────────────────

/**
 * Extracts the registrable root domain from a URL string using tldts.
 * Correctly handles:
 * - Subdomains: www.shop.example.com → example.com
 * - Multi-part TLDs: www.shop.example.co.uk → example.co.uk
 * - Missing protocol: adds https:// prefix before parsing
 *
 * Returns empty string if the URL is empty or unparseable.
 */
export function extractRootDomain(url: string): string {
  if (!url || url.trim().length === 0) return '';

  try {
    const normalised = url.startsWith('http') ? url : `https://${url}`;
    const parsed = parseTld(normalised);
    return parsed.domain ?? '';
  } catch {
    return '';
  }
}

// ─── Dedup Key Builder ────────────────────────────────────────────────────────

/**
 * Builds the dedup key for a raw lead.
 * Format: `${normalizedPhone}|${rootDomain}`
 *
 * normalizedPhone: raw phone trimmed of whitespace (full E.164 normalisation
 * happens later in phoneNormalizer — not needed for dedup purposes).
 * rootDomain: extracted via tldts from the website URL.
 */
export function buildDedupKey(rawPhone: string, websiteUrl: string): string {
  const phone = (rawPhone ?? '').trim();
  const domain = extractRootDomain(websiteUrl);
  return `${phone}|${domain}`;
}

// ─── Rolling Window Helpers (exported for testing) ───────────────────────────

/**
 * Returns the current size of the rolling window (number of tracked keys).
 * Useful for monitoring and tests.
 */
export function getRollingWindowSize(): number {
  return rollingWindow.size;
}

/**
 * Clears the rolling window entirely.
 * Intended for use in tests only — do NOT call in production code.
 */
export function clearRollingWindowForTesting(): void {
  rollingWindow.clear();
}

// ─── Phase 5.1: Per-key Mutex ─────────────────────────────────────────────────

/**
 * Per-key promise chain used to serialize concurrent dedup checks for the
 * same key. Prevents TOCTOU races when multiple city jobs run in parallel.
 *
 * Map<key, Promise<void>> — each entry is the tail of the promise chain for
 * that key. A new waiter appends to the tail; when it's done it resolves,
 * allowing the next waiter to proceed.
 */
const dedupLocks = new Map<string, Promise<void>>();

/**
 * Acquires a per-key lock. Returns a release function.
 * Callers MUST call release() in a finally block.
 *
 * Pattern: each caller creates a new promise and chains it onto the existing
 * tail for the key. The release function resolves that promise, unblocking
 * the next waiter. The release function is captured synchronously before
 * any await, so it is always defined when the caller needs it.
 */
async function acquireDedupLock(key: string): Promise<() => void> {
  let release!: () => void;
  // Create the promise that THIS caller will hold the lock for
  const lockPromise = new Promise<void>((resolve) => { release = resolve; });

  // Chain: wait for the previous tail, then hold our lock
  const prev = dedupLocks.get(key) ?? Promise.resolve();
  dedupLocks.set(key, prev.then(() => lockPromise));

  // Wait until all previous holders have released
  await prev;

  // Cleanup: remove the key when our lock is released
  const originalRelease = release;
  return () => {
    originalRelease();
    // Only delete if our promise is still the tail (no new waiters)
    if (dedupLocks.get(key) === prev.then(() => lockPromise)) {
      dedupLocks.delete(key);
    }
  };
}

// ─── Main Dedup Function ──────────────────────────────────────────────────────

/**
 * Checks whether a RawLead is a duplicate.
 *
 * Duplicate if EITHER:
 *   - Layer 1: key is in the per-run store.dedupSet (same job session), OR
 *   - Layer 2: key is in the rolling window AND was seen within DEDUP_WINDOW_DAYS
 *
 * Phase 5.1: the check-then-add sequence is protected by a per-key mutex so
 * concurrent city jobs cannot race on the same key.
 *
 * Returns true  → lead is a duplicate, skip it.
 * Returns false → lead is new, proceed to scraping.
 *
 * Side effects on duplicate:
 *   - Increments store.failureMetrics.duplicate_skipped
 *   - Logs the skipped business name and which layer caught it
 *
 * Side effects on new lead:
 *   - Adds key to rolling window with current timestamp
 *   (store.isDuplicate() also adds to per-run Set as a side effect)
 */
export async function isDuplicateLead(lead: RawLead): Promise<boolean> {
  const key = buildDedupKey(lead.rawPhone, lead.website);

  // No key can be formed — pass through without deduplication
  if (!key || key === '|') {
    return false;
  }

  // Acquire per-key lock — serializes concurrent checks for the same key
  const release = await acquireDedupLock(key);

  try {
    // Cleanup stale rolling window entries before checking
    cleanupRollingWindow();

    // ── Layer 2: Rolling window check ───────────────────────────────────────
    const seenAt = rollingWindow.get(key);
    if (seenAt !== undefined) {
      const ageMs = Date.now() - seenAt;
      if (ageMs < DEDUP_WINDOW_MS) {
        store.incrementMetric('duplicate_skipped');
        logger.info(
          `Dedup [rolling]: skipped "${lead.name}" — seen ${Math.round(ageMs / 86400000 * 10) / 10}d ago (key: ${key})`
        );
        store.isDuplicate(key);
        return true;
      }
      rollingWindow.delete(key);
    }

    // ── Layer 1: Per-run Set check ──────────────────────────────────────────
    if (store.isDuplicate(key)) {
      store.incrementMetric('duplicate_skipped');
      logger.info(`Dedup [per-run]: skipped "${lead.name}" (key: ${key})`);
      rollingWindow.set(key, Date.now());
      return true;
    }

    // ── New lead — register in rolling window ───────────────────────────────
    rollingWindow.set(key, Date.now());
    return false;
  } finally {
    release();
  }
}
