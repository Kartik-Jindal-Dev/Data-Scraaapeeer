/**
 * scheduler.ts
 * Scheduled tasks for database maintenance.
 * Currently handles dedup record cleanup with configurable interval.
 */

import { DedupRepository } from './repositories/DedupRepository';

// ─── Configuration ─────────────────────────────────────────────────────────────

/** Cleanup interval in milliseconds (default: 24 hours) */
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Cleanup interval in milliseconds for testing (default: 1 minute) */
const CLEANUP_INTERVAL_MS_TEST = 60 * 1000;

let cleanupIntervalId: NodeJS.Timeout | null = null;

// ─── Scheduled Tasks ───────────────────────────────────────────────────────────

/**
 * Runs the dedup record cleanup task.
 * Removes records older than the 15-day rolling window.
 * Logs the number of records removed.
 */
function runDedupCleanup(): void {
  try {
    const removedCount = DedupRepository.cleanupExpiredRecords();
    
    if (removedCount > 0) {
      console.log(`[Scheduler] Cleaned up ${removedCount} expired dedup records`);
    }
  } catch (error) {
    console.error('[Scheduler] Error during dedup cleanup:', error);
  }
}

/**
 * Starts the scheduled dedup cleanup task.
 * Runs every 24 hours by default, or every minute in test mode.
 */
export function startScheduler(testMode = false): void {
  if (cleanupIntervalId) {
    console.warn('[Scheduler] Scheduler already running');
    return;
  }

  const interval = testMode ? CLEANUP_INTERVAL_MS_TEST : CLEANUP_INTERVAL_MS;
  
  // Run immediately on startup
  runDedupCleanup();
  
  // Schedule recurring cleanup
  cleanupIntervalId = setInterval(runDedupCleanup, interval);
  
  console.log(`[Scheduler] Started (interval: ${interval}ms)`);
}

/**
 * Stops the scheduled dedup cleanup task.
 */
export function stopScheduler(): void {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
    console.log('[Scheduler] Stopped');
  }
}

/**
 * Returns whether the scheduler is currently running.
 */
export function isSchedulerRunning(): boolean {
  return cleanupIntervalId !== null;
}
