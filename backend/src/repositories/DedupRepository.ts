/**
 * DedupRepository.ts
 * Repository for lead deduplication with 15-day rolling window.
 * Replaces in-memory Map with persistent SQLite storage.
 */

import { getDb } from '../db/db';

// ─── Configuration ─────────────────────────────────────────────────────────────

const DEDUP_WINDOW_DAYS = 15;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEDUP_WINDOW_MS = DEDUP_WINDOW_DAYS * MS_PER_DAY;

// ─── Repository Interface ─────────────────────────────────────────────────────────

export const DedupRepository = {
  /**
   * Checks if a dedup key has been seen within the rolling window.
   * Key format: `${normalizedPhone}|${rootDomain}`
   * Returns true if duplicate (should be skipped), false if new.
   * Automatically cleans up expired records before checking.
   */
  isDuplicate(key: string): boolean {
    if (!key || key === '|') return false;

    this.cleanupExpiredRecords();

    const db = getDb();
    const stmt = db.prepare('SELECT first_seen_at FROM dedup_records WHERE dedup_key = ?');
    const row = stmt.get(key) as { first_seen_at: number } | undefined;

    if (!row) {
      // New record - insert it
      this.insert(key);
      return false;
    }

    // Record exists - check if it's still within the window
    const now = Date.now();
    const age = now - row.first_seen_at;

    if (age > DEDUP_WINDOW_MS) {
      // Expired - remove it and treat as new
      this.delete(key);
      this.insert(key);
      return false;
    }

    // Within window - it's a duplicate
    return true;
  },

  /**
   * Inserts a new dedup record.
   */
  insert(key: string): void {
    const db = getDb();
    const now = Date.now();

    const stmt = db.prepare(
      'INSERT OR REPLACE INTO dedup_records (dedup_key, first_seen_at) VALUES (?, ?)'
    );
    stmt.run(key, now);
  },

  /**
   * Deletes a dedup record by key.
   */
  delete(key: string): boolean {
    const db = getDb();
    const stmt = db.prepare('DELETE FROM dedup_records WHERE dedup_key = ?');
    const result = stmt.run(key);
    return result.changes > 0;
  },

  /**
   * Cleans up all records older than the dedup window.
   * Should be called automatically before each check and periodically via scheduled task.
   */
  cleanupExpiredRecords(): number {
    const db = getDb();
    const cutoffTime = Date.now() - DEDUP_WINDOW_MS;

    const stmt = db.prepare('DELETE FROM dedup_records WHERE first_seen_at < ?');
    const result = stmt.run(cutoffTime);

    return result.changes;
  },

  /**
   * Returns the current size of the dedup window (number of active records).
   */
  getWindowSize(): number {
    const db = getDb();
    const cutoffTime = Date.now() - DEDUP_WINDOW_MS;

    const stmt = db.prepare('SELECT COUNT(*) as count FROM dedup_records WHERE first_seen_at >= ?');
    const result = stmt.get(cutoffTime) as { count: number };

    return result.count;
  },

  /**
   * Returns the total number of records in the dedup table (including expired).
   * Useful for monitoring cleanup effectiveness.
   */
  getTotalCount(): number {
    const db = getDb();
    const stmt = db.prepare('SELECT COUNT(*) as count FROM dedup_records');
    const result = stmt.get() as { count: number };
    return result.count;
  },

  /**
   * Clears all dedup records.
   * Used for testing or manual reset.
   */
  clearAll(): number {
    const db = getDb();
    const stmt = db.prepare('DELETE FROM dedup_records');
    const result = stmt.run();
    return result.changes;
  },

  /**
   * Clears all dedup records for testing isolation.
   * Should only be called in test environments.
   */
  clearForTesting(): void {
    this.clearAll();
  },

  /**
   * Gets statistics about the dedup window.
   */
  getStats(): {
    windowSize: number;
    totalCount: number;
    windowDays: number;
    cutoffTime: number;
  } {
    return {
      windowSize: this.getWindowSize(),
      totalCount: this.getTotalCount(),
      windowDays: DEDUP_WINDOW_DAYS,
      cutoffTime: Date.now() - DEDUP_WINDOW_MS,
    };
  },
};
