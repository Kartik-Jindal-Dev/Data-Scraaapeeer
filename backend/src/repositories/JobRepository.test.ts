/// <reference types="jest" />
/**
 * JobRepository.test.ts
 * Unit tests for JobRepository using in-memory SQLite.
 */

import Database from 'better-sqlite3';
import { JobRepository } from './JobRepository';
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
          CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            keyword TEXT NOT NULL,
            location TEXT NOT NULL,
            depth TEXT NOT NULL,
            iso_country_code TEXT NOT NULL,
            contact_filter TEXT NOT NULL,
            max_leads INTEGER NOT NULL,
            status TEXT NOT NULL,
            lead_count INTEGER DEFAULT 0,
            discard_count INTEGER DEFAULT 0,
            started_at INTEGER,
            completed_at INTEGER
          );
        `);
      }
      return memDb;
    }),
  };
});

function makeContext(overrides: any = {}): any {
  return {
    jobId: overrides.jobId || `job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    keyword: overrides.keyword || 'test-keyword',
    location: overrides.location || 'Test Location',
    depth: overrides.depth || 'homepage',
    isoCountryCode: overrides.isoCountryCode || 'US',
    contactFilter: overrides.contactFilter || 'any',
    maxLeads: overrides.maxLeads || 100,
    ...overrides,
  };
}

describe('JobRepository', () => {
  beforeEach(() => {
    const db = dbModule.getDb();
    db.exec('DELETE FROM jobs');
  });

  afterAll(() => {
    const db = dbModule.getDb();
    db.close();
  });

  describe('create()', () => {
    it('creates a new job and returns its ID', () => {
      const ctx = makeContext();
      const id = JobRepository.create(ctx);
      expect(id).toBe(ctx.jobId);
    });

    it('persists all job fields', () => {
      const ctx = makeContext({ keyword: 'plumber', maxLeads: 50 });
      JobRepository.create(ctx);
      const found = JobRepository.findById(ctx.jobId);
      expect(found).not.toBeNull();
      expect(found!.keyword).toBe('plumber');
      expect(found!.maxLeads).toBe(50);
    });
  });

  describe('findById()', () => {
    it('returns null for non-existent job', () => {
      expect(JobRepository.findById('no-such-job')).toBeNull();
    });

    it('returns the job when it exists', () => {
      const ctx = makeContext();
      JobRepository.create(ctx);
      const found = JobRepository.findById(ctx.jobId);
      expect(found).not.toBeNull();
      expect(found!.jobId).toBe(ctx.jobId);
    });
  });

  describe('findAll()', () => {
    it('returns all jobs ordered by started_at desc', () => {
      const ctx1 = makeContext();
      const ctx2 = makeContext();
      JobRepository.create(ctx1);
      JobRepository.create(ctx2);

      const jobs = JobRepository.findAll();
      expect(jobs).toHaveLength(2);
    });

    it('filters by status', () => {
      const running = makeContext();
      const completed = makeContext();
      JobRepository.create(running);
      JobRepository.create(completed);
      JobRepository.updateStatus(running.jobId, 'running');
      JobRepository.updateStatus(completed.jobId, 'completed');

      const runningJobs = JobRepository.findAll({ status: 'running' as any });
      expect(runningJobs).toHaveLength(1);
      expect(runningJobs[0].jobId).toBe(running.jobId);
    });

    it('supports pagination', () => {
      for (let i = 0; i < 5; i++) {
        JobRepository.create(makeContext());
      }

      const page1 = JobRepository.findAll({ limit: 2, offset: 0 });
      expect(page1).toHaveLength(2);

      const page2 = JobRepository.findAll({ limit: 2, offset: 2 });
      expect(page2).toHaveLength(2);

      const page3 = JobRepository.findAll({ limit: 2, offset: 4 });
      expect(page3).toHaveLength(1);
    });
  });

  describe('updateStatus()', () => {
    it('updates job status', () => {
      const ctx = makeContext();
      JobRepository.create(ctx);
      expect(JobRepository.findById(ctx.jobId)).not.toBeNull();

      const updated = JobRepository.updateStatus(ctx.jobId, 'running');
      expect(updated).toBe(true);
    });

    it('returns false for non-existent job', () => {
      expect(JobRepository.updateStatus('no-such', 'running')).toBe(false);
    });
  });

  describe('markCompleted() / markStopped() / markError()', () => {
    it('marks a job completed with counts', () => {
      const ctx = makeContext();
      JobRepository.create(ctx);
      JobRepository.markCompleted(ctx.jobId, 42, 5);

      const stats = JobRepository.getJobStats(ctx.jobId);
      expect(stats).not.toBeNull();
      expect(stats!.leadCount).toBe(42);
      expect(stats!.discardCount).toBe(5);
      expect(stats!.status).toBe('completed');
    });

    it('marks a job stopped', () => {
      const ctx = makeContext();
      JobRepository.create(ctx);
      JobRepository.markStopped(ctx.jobId, 10, 2);

      const stats = JobRepository.getJobStats(ctx.jobId);
      expect(stats!.status).toBe('stopped');
    });

    it('marks a job errored', () => {
      const ctx = makeContext();
      JobRepository.create(ctx);
      JobRepository.markError(ctx.jobId);

      const stats = JobRepository.getJobStats(ctx.jobId);
      expect(stats!.status).toBe('error');
    });
  });

  describe('deleteById()', () => {
    it('deletes an existing job', () => {
      const ctx = makeContext();
      JobRepository.create(ctx);
      expect(JobRepository.deleteById(ctx.jobId)).toBe(true);
      expect(JobRepository.findById(ctx.jobId)).toBeNull();
    });

    it('returns false for non-existent job', () => {
      expect(JobRepository.deleteById('no-such')).toBe(false);
    });
  });

  describe('countAll()', () => {
    it('counts all jobs', () => {
      JobRepository.create(makeContext());
      JobRepository.create(makeContext());
      expect(JobRepository.countAll()).toBe(2);
    });

    it('filters by status', () => {
      const ctx = makeContext();
      JobRepository.create(ctx);
      JobRepository.create(makeContext());
      JobRepository.updateStatus(ctx.jobId, 'completed');

      expect(JobRepository.countAll('completed' as any)).toBe(1);
      expect(JobRepository.countAll('running' as any)).toBe(0);
    });
  });

  describe('getAllStats()', () => {
    it('returns aggregate stats across all jobs', () => {
      const ctx1 = makeContext();
      const ctx2 = makeContext();
      JobRepository.create(ctx1);
      JobRepository.create(ctx2);
      JobRepository.markCompleted(ctx1.jobId, 10, 2);
      JobRepository.markCompleted(ctx2.jobId, 20, 3);

      const stats = JobRepository.getAllStats();
      expect(stats.totalJobs).toBe(2);
      expect(stats.totalLeads).toBe(30);
      expect(stats.totalDiscards).toBe(5);
    });

    it('returns zeros when no jobs exist', () => {
      const stats = JobRepository.getAllStats();
      expect(stats.totalJobs).toBe(0);
      expect(stats.totalLeads).toBe(0);
      expect(stats.totalDiscards).toBe(0);
    });
  });

  describe('findByKeyword()', () => {
    it('finds jobs by keyword', () => {
      const ctx = makeContext({ keyword: 'plumber' });
      JobRepository.create(ctx);
      JobRepository.create(makeContext({ keyword: 'electrician' }));

      const results = JobRepository.findByKeyword('plumber');
      expect(results).toHaveLength(1);
      expect(results[0].keyword).toBe('plumber');
    });
  });
});