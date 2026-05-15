/**
 * DedupRepository.test.ts
 * Unit tests for DedupRepository using in-memory SQLite.
 */

/// <reference types="jest" />
import Database from 'better-sqlite3';
import { DedupRepository } from './DedupRepository';
import * as dbModule from '../db/db';

jest.mock('../db/db', () => {
  const Database = require('better-sqlite3');
  let memDb: any = null;
  return {
    getDb: jest.fn(() => {
      if (!memDb) {
        memDb = new Database(':memory:');
        memDb.pragma('journal_mode = WAL');
        memDb.pragma('foreign_keys = ON');
        memDb.exec(`
          CREATE TABLE IF NOT EXISTS dedup_records (
            dedup_key TEXT PRIMARY KEY,
            first_seen_at INTEGER NOT NULL
          );
        `);
      }
      return memDb;
    }),
  };
});

describe('DedupRepository', () => {
  beforeEach(() => {
    const db = dbModule.getDb();
    db.exec('DELETE FROM dedup_records');
  });

  afterAll(() => {
    const db = dbModule.getDb();
    db.close();
  });

  describe('isDuplicate()', () => {
    it('returns false for a new key', () => {
      expect(DedupRepository.isDuplicate('+12025551234|acme.com')).toBe(false);
    });

    it('returns true for an existing key within window', () => {
      DedupRepository.isDuplicate('+12025551234|acme.com');
      expect(DedupRepository.isDuplicate('+12025551234|acme.com')).toBe(true);
    });

    it('returns false for different keys', () => {
      DedupRepository.isDuplicate('+12025551234|acme.com');
      expect(DedupRepository.isDuplicate('+12025551235|acme.com')).toBe(false);
      expect(DedupRepository.isDuplicate('+12025551234|beta.com')).toBe(false);
    });

    it('returns false for empty key (no phone, no domain)', () => {
      expect(DedupRepository.isDuplicate('|')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(DedupRepository.isDuplicate('')).toBe(false);
    });
  });

  describe('insert()', () => {
    it('inserts a new record', () => {
      DedupRepository.insert('test-key');
      expect(DedupRepository.isDuplicate('test-key')).toBe(true);
    });

    it('replaces an existing record', () => {
      DedupRepository.insert('test-key');
      DedupRepository.insert('test-key'); // should not throw
      expect(DedupRepository.isDuplicate('test-key')).toBe(true);
    });
  });

  describe('delete()', () => {
    it('deletes an existing record', () => {
      DedupRepository.insert('test-key');
      expect(DedupRepository.delete('test-key')).toBe(true);
      expect(DedupRepository.isDuplicate('test-key')).toBe(false);
    });

    it('returns false for non-existent key', () => {
      expect(DedupRepository.delete('no-such-key')).toBe(false);
    });
  });

  describe('cleanupExpiredRecords()', () => {
    it('removes records older than the window', () => {
      const db = dbModule.getDb();
      const longAgo = Date.now() - 20 * 24 * 60 * 60 * 1000; // 20 days ago
      db.prepare('INSERT INTO dedup_records (dedup_key, first_seen_at) VALUES (?, ?)').run('old-key', longAgo);
      db.prepare('INSERT INTO dedup_records (dedup_key, first_seen_at) VALUES (?, ?)').run('fresh-key', Date.now());

      const removed = DedupRepository.cleanupExpiredRecords();
      expect(removed).toBe(1);

      // Fresh key should remain
      expect(DedupRepository.isDuplicate('fresh-key')).toBe(true);
    });

    it('returns 0 when no records are expired', () => {
      DedupRepository.insert('fresh-key');
      const removed = DedupRepository.cleanupExpiredRecords();
      expect(removed).toBe(0);
    });
  });

  describe('getWindowSize() / getTotalCount()', () => {
    it('returns correct count of active records', () => {
      DedupRepository.insert('key1');
      DedupRepository.insert('key2');
      expect(DedupRepository.getWindowSize()).toBe(2);
      expect(DedupRepository.getTotalCount()).toBe(2);
    });

    it('excludes expired records from window size', () => {
      const db = dbModule.getDb();
      const longAgo = Date.now() - 20 * 24 * 60 * 60 * 1000;
      db.prepare('INSERT INTO dedup_records (dedup_key, first_seen_at) VALUES (?, ?)').run('old-key', longAgo);

      expect(DedupRepository.getWindowSize()).toBe(0);
      expect(DedupRepository.getTotalCount()).toBe(1);
    });
  });

  describe('clearAll()', () => {
    it('clears all records', () => {
      DedupRepository.insert('key1');
      DedupRepository.insert('key2');
      const removed = DedupRepository.clearAll();
      expect(removed).toBe(2);
      expect(DedupRepository.getWindowSize()).toBe(0);
    });
  });

  describe('getStats()', () => {
    it('returns stats object', () => {
      DedupRepository.insert('key1');
      const stats = DedupRepository.getStats();
      expect(stats.windowSize).toBe(1);
      expect(stats.windowDays).toBe(15);
      expect(stats.totalCount).toBe(1);
      expect(typeof stats.cutoffTime).toBe('number');
    });
  });
});